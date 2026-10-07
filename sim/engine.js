// Building blocks for simulated service-to-service calls. Every call produces a CLIENT
// span in the caller and a SERVER span in the callee (as separate services) with the
// trace context linked, plus logs and metrics from the callee.
const { AsyncLocalStorage } = require('async_hooks');
const { trace, context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode } = require('@opentelemetry/api');
const { suppressTracing } = require('@opentelemetry/core');
const { SeverityNumber } = require('@opentelemetry/api-logs');
const scenarios = require('./scenarios');

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

class SimError extends Error {
  constructor(status, message, service) {
    super(message);
    this.name = 'SimError';
    this.status = status;
    this.service = service;
  }
}

const config = { ordersBase: 'http://localhost:3000' };
const configure = (c) => Object.assign(config, c);

function log(svc, ctx, level, body, attributes = {}) {
  const severityNumber = { info: SeverityNumber.INFO, warn: SeverityNumber.WARN, error: SeverityNumber.ERROR }[level];
  svc.logger.emit({ severityNumber, severityText: level.toUpperCase(), body, attributes, context: ctx });
  if (process.env.SIM_VERBOSE === 'true') console.log(`[sim:${svc.name}] ${level} ${body}`);
}

function latency(profile, f) {
  const [lo, hi] = profile.latency;
  return rand(lo, hi) * f.latencyMult + f.extraMs;
}

// Status a callee reports. Failures that came from further downstream surface as 502.
function statusFor(err, serviceName) {
  if (err instanceof SimError) return err.service === serviceName ? err.status : 502;
  return 500;
}

// Call `to` from `from`: CLIENT span (from) -> SERVER span (to) -> handler work.
async function rpc(ctx, from, to, { method = 'GET', route, handler }) {
  const clientSpan = from.tracer.startSpan(
    `${method} ${route}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.request.method': method,
        'url.template': route,
        'server.address': to.host,
        'peer.service': to.name,
      },
    },
    ctx
  );
  const clientCtx = trace.setSpan(ctx, clientSpan);
  const serverSpan = to.tracer.startSpan(
    `${method} ${route}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        'http.request.method': method,
        'http.route': route,
        'url.path': route,
        'server.address': to.host,
        'user_agent.original': `${from.name}/http-client`,
      },
    },
    clientCtx
  );
  const serverCtx = trace.setSpan(clientCtx, serverSpan);
  const started = Date.now();
  let status = 200;
  try {
    const f = scenarios.faultsFor(to.name);
    const ms = latency(to.profile, f);
    await sleep(ms / 2);
    if (Math.random() < f.errorRate) throw new SimError(f.status, f.message, to.name);
    const out = handler ? await handler(serverCtx) : undefined;
    await sleep(ms / 2);
    return out;
  } catch (err) {
    status = statusFor(err, to.name);
    const e =
      err instanceof SimError && err.service === to.name
        ? err
        : new SimError(
            status,
            status === 502 ? `upstream ${err.service || 'dependency'} failed: ${err.message}` : err.message,
            to.name
          );
    serverSpan.recordException(e);
    if (status >= 500) serverSpan.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
    clientSpan.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
    log(to, serverCtx, status >= 500 ? 'error' : 'warn', `${method} ${route} -> ${status}: ${e.message}`, {
      'http.route': route,
      'http.response.status_code': status,
    });
    to.errors.add(1, { 'http.route': route, 'http.response.status_code': status });
    throw e;
  } finally {
    serverSpan.setAttribute('http.response.status_code', status);
    clientSpan.setAttribute('http.response.status_code', status);
    to.duration.record((Date.now() - started) / 1000, {
      'http.route': route,
      'http.request.method': method,
      'http.response.status_code': status,
    });
    serverSpan.end();
    clientSpan.end();
  }
}

// Lets a caller (the storefront API) make the next entry() a child of an incoming browser trace.
const parentStore = new AsyncLocalStorage();
const withParent = (parent, fn) => parentStore.run(parent, fn);

// A trace's root: an inbound request to the api-gateway. Never throws.
async function entry(S, method, route, handler) {
  const gw = S.gateway;
  const parent = parentStore.getStore() || ROOT_CONTEXT;
  const span = gw.tracer.startSpan(
    `${method} ${route}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        'http.request.method': method,
        'http.route': route,
        'url.path': route,
        'server.address': 'api.shop.example.com',
        'user_agent.original': 'Mozilla/5.0 (simulated)',
        'client.address': `203.0.113.${rand(1, 254)}`,
      },
    },
    parent
  );
  const ctx = trace.setSpan(parent, span);
  const started = Date.now();
  let status = 200;
  try {
    const f = scenarios.faultsFor(gw.name);
    const ms = latency(gw.profile, f);
    await sleep(ms / 2);
    if (Math.random() < f.errorRate) throw new SimError(f.status, f.message, gw.name);
    await handler(ctx);
    await sleep(ms / 2);
  } catch (err) {
    if (err instanceof SimError) {
      if (err.service === gw.name) status = err.status;
      else if (err.status >= 500) status = err.status === 504 ? 504 : 502;
      else status = err.status;
    } else {
      status = 500;
    }
    span.recordException(err);
    if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    log(gw, ctx, status >= 500 ? 'error' : 'warn', `${method} ${route} -> ${status}: ${err.message}`, {
      'http.route': route,
      'http.response.status_code': status,
    });
    gw.errors.add(1, { 'http.route': route, 'http.response.status_code': status });
  } finally {
    span.setAttribute('http.response.status_code', status);
    gw.duration.record((Date.now() - started) / 1000, {
      'http.route': route,
      'http.request.method': method,
      'http.response.status_code': status,
    });
    span.end();
  }
  return status;
}

// Internal work inside a service (INTERNAL span).
async function work(svc, ctx, name, ms, attributes = {}) {
  const span = svc.tracer.startSpan(name, { kind: SpanKind.INTERNAL, attributes }, ctx);
  try {
    await sleep(ms);
  } finally {
    span.end();
  }
}

// A database call from a service (CLIENT span with db.* attributes).
async function db(svc, ctx, system, name, statement, ms) {
  const span = svc.tracer.startSpan(
    name,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'db.system': system,
        'db.statement': statement,
        'db.operation': name.split(' ')[0],
        'server.address': `${system}.internal`,
      },
    },
    ctx
  );
  try {
    await sleep(ms);
  } finally {
    span.end();
  }
}

// A call from a service to a third-party API (CLIENT span).
async function external(svc, ctx, host, method, route, ms) {
  const span = svc.tracer.startSpan(
    `${method} ${host}`,
    {
      kind: SpanKind.CLIENT,
      attributes: { 'http.request.method': method, 'server.address': host, 'url.path': route, 'peer.service': host },
    },
    ctx
  );
  try {
    await sleep(ms);
    span.setAttribute('http.response.status_code', 200);
  } finally {
    span.end();
  }
}

// Call the REAL orders-live app over HTTP, propagating trace context so its auto-instrumented
// server span and Postgres spans join this trace. `route` is the span name template.
async function callOrders(ctx, from, method, path, route, body) {
  const url = config.ordersBase + path;
  const clientSpan = from.tracer.startSpan(
    `${method} ${route}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.request.method': method,
        'url.full': url,
        'server.address': 'orders-live',
        'peer.service': 'orders-live',
      },
    },
    ctx
  );
  const clientCtx = trace.setSpan(ctx, clientSpan);
  const headers = { 'content-type': 'application/json' };
  propagation.inject(clientCtx, headers);
  let status = 0;
  try {
    // Suppress auto-instrumentation so only our client span represents this hop.
    const res = await context.with(suppressTracing(context.active()), () =>
      fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
    );
    status = res.status;
    const text = await res.text();
    if (status >= 400) {
      let message = `orders-live returned ${status}`;
      try { message = JSON.parse(text).error || message; } catch (_) { /* not json */ }
      throw new SimError(status, message, 'orders-live');
    }
    try { return JSON.parse(text); } catch (_) { return text; }
  } catch (err) {
    if (!(err instanceof SimError)) {
      status = 503;
      err = new SimError(503, `orders-live unreachable: ${err.message}`, 'orders-live');
    }
    clientSpan.recordException(err);
    clientSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    throw err;
  } finally {
    clientSpan.setAttribute('http.response.status_code', status);
    clientSpan.end();
  }
}

module.exports = { withParent, sleep, rand, SimError, configure, log, rpc, entry, work, db, external, callOrders };
