// Loaded before the app via `node -r ./tracing.js server.js`.
// Connection settings come from standard OTEL_* env vars (see .env.example).
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-grpc');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-grpc');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { wrap } = require('./telemetry-stats');

const sdk = new NodeSDK({
  traceExporter: wrap(new OTLPTraceExporter(), 'traces'),
  metricReader: new PeriodicExportingMetricReader({
    exporter: wrap(new OTLPMetricExporter(), 'metrics'),
    exportIntervalMillis: 15000,
  }),
  logRecordProcessors: [new BatchLogRecordProcessor(wrap(new OTLPLogExporter(), 'logs'))],
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false }, // noisy
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
    }),
  ],
});

sdk.start();
console.log(`[otel] started, service=${process.env.OTEL_SERVICE_NAME || 'unknown_service'}`);

const shutdown = () =>
  sdk.shutdown().catch(() => {}).finally(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
