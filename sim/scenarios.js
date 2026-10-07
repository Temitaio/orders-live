const { PROFILES } = require('./profiles');

const byName = Object.fromEntries(PROFILES.map((p) => [p.name, p]));

// Each scenario overrides the baseline behavior of one or more services.
// '*' applies to every service. _rateMult scales overall traffic.
const SCENARIOS = {
  normal: { description: 'Everything healthy (baseline noise only).' },
  payment_outage: {
    description: 'Card processor failing: payment-service errors ~80% with slow timeouts; checkout retries.',
    'payment-service': { errorRate: 0.8, status: 503, message: 'upstream card processor timeout', extraMs: 1500 },
  },
  slow_inventory: {
    description: 'inventory-service database is 10x slower; latency cascades to checkout and browse.',
    'inventory-service': { latencyMult: 10 },
  },
  auth_degraded: {
    description: 'auth-service session store flaky: 30% errors and 4x latency on every authenticated request.',
    'auth-service': { errorRate: 0.3, status: 500, message: 'redis connection reset by peer', latencyMult: 4 },
  },
  notification_down: {
    description: 'notification-service fully down; checkouts succeed but emails fail (warnings, no user impact).',
    'notification-service': { errorRate: 1, status: 503, message: 'smtp relay unavailable' },
  },
  search_degraded: {
    description: 'search-service slow (8x) with 10% gateway timeouts on product browsing.',
    'search-service': { errorRate: 0.1, status: 504, message: 'elasticsearch query timeout', latencyMult: 8 },
  },
  shipping_rate_limited: {
    description: 'Carrier API rate limits shipping-service: 40% 429s on labels and tracking.',
    'shipping-service': { errorRate: 0.4, status: 429, message: 'carrier api rate limit exceeded' },
  },
  black_friday: {
    description: 'Traffic spike (4x) with higher latency and a few percent extra errors everywhere.',
    '*': { latencyMult: 1.8, errorRateAdd: 0.03 },
    _rateMult: 4,
  },
};

const state = { name: 'normal', until: 0 };

function expire() {
  if (state.name !== 'normal' && Date.now() > state.until) {
    state.name = 'normal';
    state.until = 0;
  }
}

function set(name, minutes = 5) {
  if (!SCENARIOS[name]) throw new Error(`unknown scenario: ${name}`);
  if (name === 'normal') {
    state.name = 'normal';
    state.until = 0;
  } else {
    state.name = name;
    state.until = Date.now() + minutes * 60 * 1000;
  }
  return current();
}

function current() {
  expire();
  const s = SCENARIOS[state.name];
  return {
    name: state.name,
    description: s.description,
    until: state.until ? new Date(state.until).toISOString() : null,
    rateMult: s._rateMult || 1,
  };
}

// Effective fault settings for a service right now.
function faultsFor(serviceName) {
  expire();
  const base = byName[serviceName];
  const sc = SCENARIOS[state.name];
  const o = Object.assign({}, sc['*'], sc[serviceName]);
  return {
    errorRate: (o.errorRate ?? base.errorRate) + (o.errorRateAdd || 0),
    status: o.status ?? base.baseError.status,
    message: o.message ?? base.baseError.message,
    latencyMult: o.latencyMult ?? 1,
    extraMs: o.extraMs ?? 0,
  };
}

const names = () => Object.keys(SCENARIOS);
const list = () => names().map((n) => ({ name: n, description: SCENARIOS[n].description }));

module.exports = { SCENARIOS, set, current, faultsFor, names, list };
