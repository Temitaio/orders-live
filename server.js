// The instrumented app ("child"). In production it is started by launcher.js, which
// serves the Demo Console and passes in the Monoscope API key. It can also run on its
// own for local work: `npm run app`.
const express = require('express');
const { trace, metrics, SpanStatusCode } = require('@opentelemetry/api');
const { logs, SeverityNumber } = require('@opentelemetry/api-logs');
const { query: q } = require('./db');

const app = express();
app.use(express.json());

const meter = metrics.getMeter('orders-live');
const otelLogger = logs.getLogger('orders-live');

const ordersCreated = meter.createCounter('orders.created', { description: 'Orders created' });
const orderValue = meter.createHistogram('orders.value', { description: 'Order value', unit: 'USD' });

// Log to console AND to OTel (trace/span ids attach automatically inside a request).
function log(level, body, attributes = {}) {
  const sev = { info: SeverityNumber.INFO, warn: SeverityNumber.WARN, error: SeverityNumber.ERROR }[level];
  console.log(`[${level}] ${body}`, Object.keys(attributes).length ? attributes : '');
  otelLogger.emit({ severityNumber: sev, severityText: level.toUpperCase(), body, attributes });
}

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const STATUSES = ['pending', 'paid', 'shipped', 'cancelled'];
const NAMES = ['ada', 'grace', 'linus', 'margaret', 'alan', 'tim', 'radia', 'ken'];

// Forward async errors to the Express error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Virtual multi-service simulation (api-gateway, auth, user, inventory, payment,
// notification, shipping, search, recommendation). Disable with SIMULATE=false.
const sim = process.env.SIMULATE !== 'false' ? require('./sim').create() : null;
if (sim) app.use('/sim', sim.router);

app.get('/', (req, res) =>
  res.json({
    app: 'orders-live',
    endpoints: ['/health', '/health/db', 'GET /orders', 'GET /orders/:id', 'POST /orders', '/report', '/slow', '/flaky', '/error'],
    simulation: sim ? ['/sim/status', '/sim/scenarios', '/sim/telemetry'] : 'disabled',
  })
);

// Liveness only: never touches the database, so health checks cannot keep Neon awake.
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/health/db', wrap(async (req, res) => {
  await q('SELECT 1');
  res.json({ status: 'ok', db: 'ok' });
}));

app.get('/orders', wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM orders ORDER BY id DESC LIMIT 20');
  res.json(rows);
}));

app.get('/orders/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await q('SELECT * FROM orders WHERE id = $1', [id]);
  if (!rows.length) {
    log('warn', 'order not found', { 'order.id': id });
    return res.status(404).json({ error: 'not found' });
  }
  res.json(rows[0]);
}));

app.post('/orders', wrap(async (req, res) => {
  const customer = req.body?.customer ?? NAMES[rand(0, NAMES.length - 1)];
  const total = req.body?.total_cents ?? rand(1000, 50000);
  const { rows } = await q(
    'INSERT INTO orders (customer, total_cents, status) VALUES ($1, $2, $3) RETURNING *',
    [customer, total, STATUSES[rand(0, 2)]]
  );
  ordersCreated.add(1);
  orderValue.record(total / 100);
  log('info', 'order created', { 'order.id': rows[0].id, 'order.total_cents': total });
  res.status(201).json(rows[0]);
}));

// Aggregate query: a heavier DB span.
app.get('/report', wrap(async (req, res) => {
  const { rows } = await q(
    'SELECT status, count(*)::int AS orders, coalesce(sum(total_cents),0)::int AS revenue_cents FROM orders GROUP BY status ORDER BY status'
  );
  res.json(rows);
}));

// Real latency inside Postgres (200ms to 3s).
app.get('/slow', wrap(async (req, res) => {
  const secs = rand(200, 3000) / 1000;
  log('warn', 'slow query', { 'delay.seconds': secs });
  await q('SELECT pg_sleep($1::float8)', [secs]);
  res.json({ slept_seconds: secs });
}));

// A genuine database error (relation does not exist).
app.get('/error', wrap(async () => {
  await q('SELECT * FROM table_that_does_not_exist');
}));

// ~30% failures from a "flaky dependency".
app.get('/flaky', wrap(async (req, res) => {
  await q('SELECT 1');
  if (Math.random() < 0.3) throw new Error('Flaky dependency timed out');
  res.json({ ok: true });
}));

// Record the exception on the active span so Monoscope can group it, and log it.
app.use((err, req, res, next) => {
  const span = trace.getActiveSpan();
  if (span) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  }
  log('error', err.message, { 'exception.stacktrace': err.stack, 'http.route': req.path });
  res.status(500).json({ error: err.message });
});

// Keep the table small (Neon free tier). Runs when simulated traffic stops, never on a timer,
// so it does not keep the database awake.
const cleanupOrders = () =>
  q('DELETE FROM orders WHERE id < (SELECT coalesce(max(id),0) - 1000 FROM orders)').catch((e) =>
    console.log('[cleanup] failed:', e.message)
  );

const port = process.env.PORT || 3000;
const host = process.env.BIND_HOST || '0.0.0.0';
app.listen(port, host, () => {
  log('info', `orders-live listening on ${host}:${port}`);
  if (sim) sim.start({ ordersBase: `http://127.0.0.1:${port}`, onIdle: cleanupOrders });
});
