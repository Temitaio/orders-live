// Gives each virtual service its own tracer, logger and meter, each with its own
// Resource (service.name etc.) so Monoscope sees them as separate services.
// The exporters and span/log processors are shared to keep memory low.
const { Resource } = require('@opentelemetry/resources');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { BatchSpanProcessor, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { LoggerProvider, BatchLogRecordProcessor, SimpleLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-grpc');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-grpc');

// Parse OTEL_RESOURCE_ATTRIBUTES ("a=b,c=d") so every service carries the same
// x-api-key and deployment.environment as the main app.
function envResourceAttributes() {
  const out = {};
  for (const pair of (process.env.OTEL_RESOURCE_ATTRIBUTES || '').split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

// opts: { traceExporter, logExporter, metricExporter, sync, metricIntervalMs } (all optional;
// the overrides exist so tests can capture telemetry in memory).
function init(opts = {}) {
  const traceExporter = opts.traceExporter || new OTLPTraceExporter();
  const logExporter = opts.logExporter || new OTLPLogExporter();
  const metricExporter = opts.metricExporter || new OTLPMetricExporter();

  const spanProcessor = opts.sync
    ? new SimpleSpanProcessor(traceExporter)
    : new BatchSpanProcessor(traceExporter, { scheduledDelayMillis: 5000 });
  const logProcessor = opts.sync
    ? new SimpleLogRecordProcessor(logExporter)
    : new BatchLogRecordProcessor(logExporter, { scheduledDelayMillis: 5000 });

  const services = [];

  function createService(profile) {
    const resource = new Resource({
      ...envResourceAttributes(),
      'service.name': profile.name,
      'service.namespace': 'shop',
      'service.version': profile.version,
      'service.instance.id': `${profile.name}-0`,
    });

    const tracerProvider = new NodeTracerProvider({ resource, spanProcessors: [spanProcessor] });
    const loggerProvider = new LoggerProvider({ resource });
    loggerProvider.addLogRecordProcessor(logProcessor);
    const meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: opts.metricIntervalMs || 15000,
        }),
      ],
    });

    const meter = meterProvider.getMeter(profile.name);
    const svc = {
      name: profile.name,
      host: `${profile.name}.internal`,
      profile,
      tracer: tracerProvider.getTracer(profile.name, profile.version),
      logger: loggerProvider.getLogger(profile.name, profile.version),
      duration: meter.createHistogram('http.server.request.duration', {
        unit: 's',
        description: 'Duration of inbound requests',
      }),
      errors: meter.createCounter('http.server.request.errors', {
        description: 'Failed inbound requests',
      }),
      meterProvider,
      loggerProvider,
      tracerProvider,
    };
    services.push(svc);
    return svc;
  }

  async function flush() {
    await Promise.all(
      services.flatMap((s) => [s.tracerProvider.forceFlush(), s.loggerProvider.forceFlush(), s.meterProvider.forceFlush()])
    );
  }

  return { createService, flush };
}

module.exports = { init, envResourceAttributes };
