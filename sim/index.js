const express = require('express');
const { ROOT_CONTEXT } = require('@opentelemetry/api');
const telemetry = require('./telemetry');
const scenarios = require('./scenarios');
const engine = require('./engine');
const journeys = require('./journeys');
const stats = require('../telemetry-stats');
const { PROFILES } = require('./profiles');

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Modes (SIM_MODE):
//   continuous - steady traffic plus automatic incident rotation (original behavior)
//   burst      - a short burst every SIM_BURST_EVERY_MINUTES (default 15); ~30% of bursts are incidents
//   manual     - no automatic traffic; only what the Demo Console triggers
// opts.telemetry is passed to telemetry.init (used by tests to capture in memory).
function create(opts = {}) {
  const tel = telemetry.init(opts.telemetry);
  const S = {};
  for (const p of PROFILES) S[p.key] = tel.createService(p);

  const mode = opts.mode || process.env.SIM_MODE || 'continuous';

  let inflight = 0;
  let sent = 0;
  let lastLogged = 'normal';
  let onIdle = null;
  let trafficTimer = null;
  let announceTimer = null;
  let burstTimer = null;
  let burstFirstTimer = null;
  const traffic = { running: false, until: 0, rate: 0 };
  let nextRotate = 0;

  const runJourney = (name) => {
    const j = journeys.journeys[name];
    if (!j) throw new Error(`unknown journey: ${name}`);
    return j.run(S);
  };

  function launch(name) {
    inflight++;
    sent++;
    runJourney(name)
      .catch((e) => console.log('[sim] journey failed:', e.message))
      .finally(() => inflight--);
  }

  // ---- Scenarios ----------------------------------------------------------
  function announce(cur) {
    if (cur.name === lastLogged) return;
    const msg = cur.name === 'normal' ? `scenario ended (was ${lastLogged})` : `scenario started: ${cur.name}`;
    engine.log(S.gateway, ROOT_CONTEXT, 'info', msg, { 'sim.scenario': cur.name });
    console.log(`[sim] ${msg}`);
    lastLogged = cur.name;
  }

  function activate(name, minutes) {
    const cur = scenarios.set(name, minutes);
    announce(cur);
    return cur;
  }

  // ---- Traffic ------------------------------------------------------------
  function scheduleNext() {
    if (!traffic.running) return;
    if (Date.now() > traffic.until) return stopTraffic();
    const rate = Math.max(1, traffic.rate * scenarios.current().rateMult);
    const wait = (60000 / rate) * (0.5 + Math.random());
    trafficTimer = setTimeout(() => {
      if (inflight < 60) launch(journeys.pick());
      scheduleNext();
    }, wait);
  }

  function startTraffic(minutes, rate) {
    clearTimeout(trafficTimer);
    traffic.running = true;
    traffic.rate = clamp(rate, 1, 120);
    traffic.until = minutes === Infinity ? Infinity : Date.now() + minutes * 60000;
    scheduleNext();
    return traffic;
  }

  function stopTraffic() {
    clearTimeout(trafficTimer);
    const was = traffic.running;
    traffic.running = false;
    traffic.until = 0;
    // Let in-flight journeys finish, then run the idle hook (table cleanup).
    if (was && onIdle) setTimeout(() => onIdle(), 4000);
  }

  // Fire a specific journey `count` times in the near future.
  function runNow(name, count = 1) {
    if (!journeys.journeys[name]) throw new Error(`unknown journey: ${name}`);
    const n = clamp(Math.floor(count), 1, 20);
    for (let i = 0; i < n; i++) setTimeout(() => launch(name), i * 400);
    if (onIdle) setTimeout(() => onIdle(), n * 400 + 8000);
    return { started: n };
  }

  // ---- Burst mode ---------------------------------------------------------
  function burst() {
    const seconds = Number(process.env.SIM_BURST_SECONDS || 60);
    const count = Number(process.env.SIM_BURST_JOURNEYS || 15);
    let name = 'normal';
    if (Math.random() < 0.3) {
      const choices = scenarios.names().filter((n) => n !== 'normal' && n !== 'black_friday');
      name = choices[engine.rand(0, choices.length - 1)];
      activate(name, seconds / 60 + 0.5);
    }
    startTraffic(seconds / 60, (count * 60) / seconds);
    console.log(`[sim] burst: ~${count} journeys over ${seconds}s, scenario=${name}`);
  }

  // ---- Lifecycle ----------------------------------------------------------
  function start({ ordersBase, onIdle: idleHook } = {}) {
    if (ordersBase) engine.configure({ ordersBase });
    onIdle = idleHook || null;

    nextRotate = Date.now() + engine.rand(3, 5) * 60000;
    announceTimer = setInterval(() => {
      announce(scenarios.current());
      if (mode === 'continuous' && process.env.SCENARIO_ROTATION !== 'false') {
        if (scenarios.current().name === 'normal' && Date.now() > nextRotate) {
          const choices = scenarios.names().filter((n) => n !== 'normal');
          const name = choices[engine.rand(0, choices.length - 1)];
          const minutes = engine.rand(3, 6);
          activate(name, minutes);
          nextRotate = Date.now() + (minutes + engine.rand(6, 12)) * 60000;
        }
      }
    }, 15000);

    if (mode === 'continuous') {
      startTraffic(Infinity, Number(process.env.SIM_RATE_PER_MIN || 20));
    } else if (mode === 'burst') {
      const every = Number(process.env.SIM_BURST_EVERY_MINUTES || 15) * 60000;
      burstFirstTimer = setTimeout(burst, 20000);
      burstTimer = setInterval(burst, every);
    }
    console.log(`[sim] ${PROFILES.length} virtual services ready, mode=${mode}, orders-live at ${ordersBase}`);
  }

  function stop() {
    clearTimeout(trafficTimer);
    clearTimeout(burstFirstTimer);
    clearInterval(announceTimer);
    clearInterval(burstTimer);
    traffic.running = false;
  }

  // ---- HTTP control (used by launcher.js; only reachable on the loopback interface) ----
  const router = express.Router();

  router.get('/status', (req, res) =>
    res.json({
      mode,
      scenario: scenarios.current(),
      traffic: {
        running: traffic.running,
        until: traffic.running && traffic.until !== Infinity ? new Date(traffic.until).toISOString() : null,
        journeysPerMinute: traffic.running ? traffic.rate : 0,
      },
      services: ['orders-live', ...PROFILES.map((p) => p.name)],
      journeys: journeys.names,
      journeysSent: sent,
      inflight,
    })
  );
  router.get('/scenarios', (req, res) => res.json(scenarios.list()));
  router.get('/telemetry', (req, res) => res.json(stats.snapshot()));

  router.post('/scenario/:name', (req, res) => {
    const minutes = clamp(Number(req.query.minutes) || 5, 1, 60);
    try {
      res.json(activate(req.params.name, minutes));
    } catch (e) {
      res.status(404).json({ error: e.message, available: scenarios.names() });
    }
  });
  router.post('/traffic/start', (req, res) => {
    const minutes = clamp(Number(req.query.minutes) || 2, 0.5, 15);
    const rate = clamp(Number(req.query.rate) || 30, 1, 120);
    startTraffic(minutes, rate);
    res.json({ running: true, minutes, journeysPerMinute: rate });
  });
  router.post('/traffic/stop', (req, res) => {
    stopTraffic();
    res.json({ running: false });
  });
  router.post('/journey/:name', (req, res) => {
    try {
      res.json(runNow(req.params.name, Number(req.query.count) || 1));
    } catch (e) {
      res.status(404).json({ error: e.message, available: journeys.names });
    }
  });

  return {
    S, mode, router, start, stop, runJourney, runNow, activate,
    startTraffic, stopTraffic,
    counters: () => ({ sent, inflight }),
    flush: tel.flush,
    configure: engine.configure,
  };
}

module.exports = { create };
