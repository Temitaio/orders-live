// Public entry point. Serves the Demo Console (public/index.html) and manages the
// instrumented app (server.js) as a child process bound to loopback only.
//
// DEMO_MODE:
//   console    - nothing runs until someone connects a Monoscope key in the console (default)
//   burst      - baseline: one short burst of traffic every SIM_BURST_EVERY_MINUTES (default 15)
//   continuous - baseline: steady traffic (uses far more Neon compute)
// In burst/continuous the baseline needs OTEL_RESOURCE_ATTRIBUTES (with x-api-key) in the env.
// A console connection temporarily replaces the baseline and restores it afterwards.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const CHILD_PORT = Number(process.env.CHILD_PORT || (PORT === 3001 ? 3002 : 3001));
const DEMO_MODE = ['console', 'burst', 'continuous'].includes(process.env.DEMO_MODE) ? process.env.DEMO_MODE : 'console';
const PASSCODE = process.env.DEMO_PASSCODE || '';
const MONOSCOPE_URL = process.env.MONOSCOPE_URL || 'https://app.monoscope.tech';
const IDLE_MS = Number(process.env.SIM_IDLE_MINUTES || 10) * 60000;
const MAX_MS = Number(process.env.SESSION_MAX_MINUTES || 120) * 60000;
const KEY_RE = /^[A-Za-z0-9+/=_.\-]{8,256}$/;
const CHILD = `http://127.0.0.1:${CHILD_PORT}`;

const baselineAttrs = process.env.OTEL_RESOURCE_ATTRIBUTES || '';
const hasBaseline = DEMO_MODE !== 'console' && /(^|,)\s*x-api-key=/.test(baselineAttrs);

let child = null; // { proc, kind: 'baseline'|'session', exited, exitCode }
let session = null; // { keyMasked, startedAt, lastActivity }
let starting = Promise.resolve();

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const mask = (k) => `${k.slice(0, 4)}…${k.slice(-4)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- child process management --------------------------------------------
function spawnChild(kind, extraEnv) {
  const env = {
    ...process.env,
    OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME || 'orders-live',
    ...extraEnv,
    PORT: String(CHILD_PORT),
    BIND_HOST: '127.0.0.1',
  };
  // The launcher's own secrets/settings should not leak into the app unnecessarily.
  delete env.DEMO_PASSCODE;
  const proc = spawn(process.execPath, ['-r', './tracing.js', 'server.js'], {
    cwd: __dirname,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const rec = { proc, kind, exited: false, exitCode: null };
  proc.on('exit', (code) => {
    rec.exited = true;
    rec.exitCode = code;
    console.log(`[launcher] ${kind} child exited (${code})`);
  });
  child = rec;
  console.log(`[launcher] started ${kind} child (pid ${proc.pid})`);
  return rec;
}

async function stopChild() {
  const rec = child;
  child = null;
  if (!rec || rec.exited) return;
  rec.proc.kill('SIGTERM');
  for (let i = 0; i < 50 && !rec.exited; i++) await sleep(100);
  if (!rec.exited) rec.proc.kill('SIGKILL');
  for (let i = 0; i < 20 && !rec.exited; i++) await sleep(100);
}

async function childJson(method, p) {
  const r = await fetch(`${CHILD}${p}`, { method, signal: AbortSignal.timeout(5000) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || `child returned ${r.status}`), { status: r.status });
  return body;
}

async function waitReady(rec, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (rec.exited) throw new Error('The demo app stopped while starting. Check DATABASE_URL on the server.');
    try {
      await childJson('GET', '/sim/status');
      return;
    } catch {
      await sleep(400);
    }
  }
  throw new Error('The demo app took too long to start.');
}

function startBaseline() {
  if (!hasBaseline) return null;
  return spawnChild('baseline', { SIM_MODE: DEMO_MODE });
}

// Serialize start/stop operations so quick clicks cannot race.
function serial(fn) {
  const run = starting.then(fn, fn);
  starting = run.catch(() => {});
  return run;
}

async function endSession() {
  session = null;
  await stopChild();
  startBaseline();
}

// ---- HTTP -----------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4kb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' })); // never touches the DB
app.get('/ping', (req, res) => res.send('pong'));

app.get('/api/info', (req, res) =>
  res.json({ passcodeRequired: !!PASSCODE, mode: DEMO_MODE, monoscopeUrl: MONOSCOPE_URL })
);

const wantedPass = PASSCODE ? sha(PASSCODE) : null;
let failures = 0;
setInterval(() => (failures = Math.max(0, failures - 5)), 60000).unref();
const guard = (req, res, next) => {
  if (!wantedPass) return next();
  if (failures > 20) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const given = sha(req.get('x-passcode') || '');
  if (crypto.timingSafeEqual(given, wantedPass)) return next();
  failures++;
  res.status(401).json({ error: 'Wrong or missing passcode.' });
};
app.use('/api', guard);
app.use('/shop-api', guard);

app.get('/api/check', (req, res) => res.json({ ok: true })); // used by the UI to validate the passcode

app.get('/api/status', async (req, res) => {
  const out = {
    mode: DEMO_MODE,
    baseline: hasBaseline,
    connected: false,
    state: child && !child.exited ? child.kind : 'idle',
    monoscopeUrl: MONOSCOPE_URL,
  };
  if (session) {
    const now = Date.now();
    out.connected = true;
    out.session = {
      key: session.keyMasked,
      startedAt: new Date(session.startedAt).toISOString(),
      idleSecondsLeft: Math.max(0, Math.round((session.lastActivity + IDLE_MS - now) / 1000)),
      maxSecondsLeft: Math.max(0, Math.round((session.startedAt + MAX_MS - now) / 1000)),
    };
    if (child && !child.exited) {
      try {
        const [st, tel] = await Promise.all([childJson('GET', '/sim/status'), childJson('GET', '/sim/telemetry')]);
        out.sim = st;
        out.telemetry = tel;
      } catch (e) {
        out.simError = e.message;
      }
    } else {
      out.simError = 'The demo app is not running.';
    }
  }
  res.json(out);
});

app.post('/api/connect', async (req, res) => {
  const key = String(req.body?.apiKey || '').trim();
  if (!KEY_RE.test(key)) {
    return res.status(400).json({ error: 'That does not look like a Monoscope API key. Copy it again from your project settings.' });
  }
  try {
    await serial(async () => {
      await stopChild();
      session = { keyMasked: mask(key), startedAt: Date.now(), lastActivity: Date.now() };
      const rec = spawnChild('session', {
        SIM_MODE: 'manual',
        OTEL_RESOURCE_ATTRIBUTES: `x-api-key=${key},deployment.environment=demo`,
      });
      try {
        await waitReady(rec);
      } catch (e) {
        await endSession();
        throw e;
      }
    });
    res.json({ connected: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/disconnect', async (req, res) => {
  await serial(endSession);
  res.json({ connected: false });
});

const ACTIONS = {
  traffic: [['POST', '/sim/traffic/start?minutes=2&rate=30']],
  checkout: [['POST', '/sim/journey/checkout?count=5']],
  error: [['POST', '/sim/journey/diagError?count=3'], ['POST', '/sim/journey/diagFlaky?count=5']],
  slow: [['POST', '/sim/journey/diagSlow?count=3']],
  stop: [['POST', '/sim/traffic/stop'], ['POST', '/sim/scenario/normal?minutes=1']],
};

app.post('/api/action', async (req, res) => {
  if (!session || !child || child.exited) return res.status(409).json({ error: 'Connect your API key first.' });
  const name = String(req.body?.action || '');
  let steps = ACTIONS[name];
  const m = /^scenario:([a-z_]+)$/.exec(name);
  if (m) {
    steps = [['POST', `/sim/scenario/${m[1]}?minutes=5`], ['POST', '/sim/traffic/start?minutes=5&rate=30']];
  }
  if (!steps) return res.status(400).json({ error: 'Unknown action.' });
  session.lastActivity = Date.now();
  try {
    for (const [method, p] of steps) await childJson(method, p);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status === 404 ? 400 : 500).json({ error: e.message });
  }
});

app.get('/api/scenarios', async (req, res) => {
  if (!child || child.exited) return res.json([]);
  try {
    res.json(await childJson('GET', '/sim/scenarios'));
  } catch {
    res.json([]);
  }
});


// ---- Demo storefront (public/shop) ------------------------------------------
// The page runs Monoscope's browser SDK (session replay + tracing) with the key the visitor
// supplies. Its same-origin calls carry a W3C traceparent that we forward to the app, so a click
// in the browser links to the backend trace.
const SDK_FILE = path.join(__dirname, 'node_modules/@monoscopetech/browser/dist/monoscope.min.js');
app.get('/vendor/monoscope.min.js', (req, res) => res.sendFile(SDK_FILE));

const PRODUCTS = [
  { id: 'p1', name: 'Trail Backpack', price: 8900, color: '#4f46e5' },
  { id: 'p2', name: 'Insulated Bottle', price: 3200, color: '#0891b2' },
  { id: 'p3', name: 'Merino Socks', price: 1800, color: '#be185d' },
  { id: 'p4', name: 'Headlamp', price: 4500, color: '#b45309' },
  { id: 'p5', name: 'Camp Stove', price: 6700, color: '#15803d' },
  { id: 'p6', name: 'Rain Shell', price: 12900, color: '#7c3aed' },
];
app.get('/shop-api/products', (req, res) => res.json(PRODUCTS));

async function shopRun(req, res, journey, done) {
  if (!session || !child || child.exited || child.kind !== 'session') {
    return res.status(409).json({ error: 'The demo is not connected. Connect your key in the Demo Console first.' });
  }
  session.lastActivity = Date.now();
  const headers = {};
  for (const h of ['traceparent', 'tracestate', 'baggage']) if (req.get(h)) headers[h] = req.get(h);
  try {
    const r = await fetch(`${CHILD}/sim/run/${journey}`, { method: 'POST', headers, signal: AbortSignal.timeout(30000) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: body.error || 'The demo app failed.' });
    return done(body.status || 200, body);
  } catch (e) {
    return res.status(504).json({ error: 'The demo app did not answer in time.' });
  }
}

app.get('/shop-api/search', (req, res) =>
  shopRun(req, res, 'browse', (status, b) => res.status(status).json({ ok: status < 400, status, traceId: b.traceId }))
);
app.post('/shop-api/login', (req, res) =>
  shopRun(req, res, 'login', (status, b) =>
    res.status(status).json({ ok: status < 400, status, error: status >= 400 ? 'Sign in failed. Try again.' : undefined, traceId: b.traceId })
  )
);
app.get('/shop-api/orders/status', (req, res) =>
  shopRun(req, res, 'orderStatus', (status, b) => res.status(status).json({ ok: status < 400, status, traceId: b.traceId }))
);
app.post('/shop-api/checkout', (req, res) =>
  shopRun(req, res, 'checkout', (status, b) =>
    res.status(status).json({
      ok: status < 400,
      status,
      error: status >= 400 ? 'Payment could not be processed. Please try again.' : undefined,
      orderRef: status < 400 ? `ORD-${crypto.randomBytes(3).toString('hex').toUpperCase()}` : undefined,
      traceId: b.traceId,
    })
  )
);
// SAVE10 works, BROKEN triggers a real backend error, anything else is a plain 404.
app.post('/shop-api/promo', (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (code === 'SAVE10') {
    if (session) session.lastActivity = Date.now();
    return res.json({ ok: true, percent: 10 });
  }
  if (code === 'BROKEN') {
    return shopRun(req, res, 'diagError', (status, b) =>
      res.status(status >= 400 ? status : 500).json({ ok: false, error: 'The promo service is having trouble right now.', traceId: b.traceId })
    );
  }
  res.status(404).json({ ok: false, error: 'That code is not valid.' });
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- Watchdog: end abandoned sessions so the database can sleep -----------
setInterval(() => {
  if (!session) return;
  const now = Date.now();
  if (now - session.lastActivity > IDLE_MS || now - session.startedAt > MAX_MS) {
    console.log('[launcher] session expired');
    serial(endSession).catch(() => {});
  }
}, 15000).unref();

// In burst/continuous mode the service must stay awake to run its schedule; Render free
// spins down after 15 minutes without inbound traffic, so ping ourselves.
if (hasBaseline && process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(`${process.env.RENDER_EXTERNAL_URL}/ping`, { signal: AbortSignal.timeout(10000) }).catch(() => {});
  }, 10 * 60000).unref();
}

const server = app.listen(PORT, () => {
  console.log(`[launcher] Demo Console on :${PORT}, mode=${DEMO_MODE}${hasBaseline ? ', baseline enabled' : ''}`);
  if (DEMO_MODE !== 'console' && !hasBaseline) {
    console.log('[launcher] baseline disabled: set OTEL_RESOURCE_ATTRIBUTES with x-api-key to enable it');
  }
  startBaseline();
});

async function shutdown() {
  server.close();
  await stopChild();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
