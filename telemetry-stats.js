// Counts export results per signal so the Demo Console can show whether Monoscope's
// collector is accepting data. Wrap any OTLP exporter with wrap(exporter, 'traces'|'logs'|'metrics').
const blank = () => ({ ok: 0, failed: 0, items: 0, lastError: null, lastOkAt: null, lastFailAt: null });
const stats = { traces: blank(), logs: blank(), metrics: blank() };

function wrap(exporter, kind) {
  if (!exporter || exporter.__statsWrapped) return exporter;
  const original = exporter.export.bind(exporter);
  exporter.export = (items, resultCallback) => {
    const n = Array.isArray(items) ? items.length : 1;
    original(items, (result) => {
      const s = stats[kind];
      if (result && result.code === 0) {
        s.ok += 1;
        s.items += n;
        s.lastOkAt = Date.now();
      } else {
        s.failed += 1;
        s.lastError = (result && result.error && (result.error.message || String(result.error))) || 'export failed';
        s.lastFailAt = Date.now();
      }
      resultCallback(result);
    });
  };
  exporter.__statsWrapped = true;
  return exporter;
}

const snapshot = () => JSON.parse(JSON.stringify(stats));

module.exports = { wrap, snapshot };
