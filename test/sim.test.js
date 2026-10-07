// Runs the simulated services with in-memory exporters and checks the telemetry shape.
// No Monoscope, database or network needed. Usage: npm test
process.env.OTEL_RESOURCE_ATTRIBUTES = 'x-api-key=test-key,deployment.environment=test';

const assert = require('assert');
const http = require('http');
const { propagation } = require('@opentelemetry/api');
const { W3CTraceContextPropagator } = require('@opentelemetry/core');
const { InMemorySpanExporter } = require('@opentelemetry/sdk-trace-base');
const { InMemoryLogRecordExporter } = require('@opentelemetry/sdk-logs');
const { InMemoryMetricExporter, AggregationTemporality } = require('@opentelemetry/sdk-metrics');

propagation.setGlobalPropagator(new W3CTraceContextPropagator());

// Stub for the real orders-live app: records the traceparent it receives.
const seen = [];
const stub = http.createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, traceparent: req.headers.traceparent });
  req.resume();
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method === 'POST') return send(201, { id: 1 });
  if (req.url.startsWith('/orders/')) return Math.random() < 0.5 ? send(200, { id: 1 }) : send(404, { error: 'not found' });
  if (req.url === '/error') return send(500, { error: 'relation does not exist' });
  send(200, { ok: true });
});

(async () => {
  await new Promise((r) => stub.listen(0, r));
  const spans = new InMemorySpanExporter();
  const logsExp = new InMemoryLogRecordExporter();
  const metricsExp = new InMemoryMetricExporter(AggregationTemporality.DELTA);

  const sim = require('../sim').create({
    telemetry: { traceExporter: spans, logExporter: logsExp, metricExporter: metricsExp, sync: true, metricIntervalMs: 3600000 },
  });
  sim.configure({ ordersBase: `http://127.0.0.1:${stub.address().port}` });

  // Speed the simulated latency up for the test.
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms, 2), ...a);

  const names = require('../sim/journeys').names;
  for (const n of names) for (let i = 0; i < 15; i++) await sim.runJourney(n);

  const finished = spans.getFinishedSpans();
  const services = new Set(finished.map((s) => s.resource.attributes['service.name']));
  console.log(`spans: ${finished.length}, services: ${[...services].sort().join(', ')}`);
  assert.strictEqual(services.size, 9, 'expected 9 virtual services');

  assert(finished.every((s) => s.resource.attributes['x-api-key'] === 'test-key'), 'every span needs the x-api-key resource attribute');

  const byTrace = new Map();
  for (const s of finished) {
    const id = s.spanContext().traceId;
    if (!byTrace.has(id)) byTrace.set(id, []);
    byTrace.get(id).push(s);
  }
  for (const [id, list] of byTrace) {
    const roots = list.filter((s) => !s.parentSpanId);
    assert.strictEqual(roots.length, 1, `trace ${id} should have exactly one root`);
    assert.strictEqual(roots[0].resource.attributes['service.name'], 'api-gateway');
  }
  console.log(`traces: ${byTrace.size}, all with a single api-gateway root`);

  // Trace context reached the (stubbed) orders-live app and points at a gateway client span.
  const withTp = seen.filter((r) => r.traceparent);
  assert(withTp.length > 0 && withTp.length === seen.length, 'every orders-live call must carry traceparent');
  const clientIds = new Set(finished.filter((s) => s.kind === 2 && s.resource.attributes['service.name'] === 'api-gateway').map((s) => s.spanContext().spanId));
  assert(withTp.every((r) => clientIds.has(r.traceparent.split('-')[2])), 'traceparent must reference an api-gateway client span');
  console.log(`orders-live calls with propagated context: ${withTp.length}`);

  const logRecords = logsExp.getFinishedLogRecords();
  assert(logRecords.length > 0, 'expected logs');
  assert(logRecords.some((l) => l.spanContext && l.spanContext.traceId), 'logs should carry trace ids');
  console.log(`logs: ${logRecords.length}`);

  // Scenario check: payment outage should make payment-service fail most of the time.
  spans.reset();
  sim.activate('payment_outage', 5);
  for (let i = 0; i < 40; i++) await sim.runJourney('checkout');
  const pay = spans.getFinishedSpans().filter((s) => s.kind === 1 && s.resource.attributes['service.name'] === 'payment-service');
  const failed = pay.filter((s) => s.status.code === 2).length;
  console.log(`payment_outage: ${failed}/${pay.length} payment server spans errored`);
  assert(pay.length > 0 && failed / pay.length > 0.5, 'payment outage scenario should produce mostly errors');
  sim.activate('normal');

  await sim.flush();
  assert(metricsExp.getMetrics().length > 0, 'expected metrics');
  console.log('OK');
  global.setTimeout = realSetTimeout;
  sim.stop();
  stub.close();
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
