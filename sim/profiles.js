// Baseline behavior of each virtual service: latency range (ms), error rate, and the
// kind of error it throws when it fails on a normal day.
const PROFILES = [
  { key: 'gateway', name: 'api-gateway', version: '2.8.1', latency: [3, 12], errorRate: 0.002,
    baseError: { status: 500, message: 'unhandled gateway error' } },
  { key: 'auth', name: 'auth-service', version: '1.14.0', latency: [8, 30], errorRate: 0.005,
    baseError: { status: 500, message: 'session store unavailable' } },
  { key: 'user', name: 'user-service', version: '3.2.4', latency: [10, 40], errorRate: 0.004,
    baseError: { status: 500, message: 'profile lookup failed: connection pool exhausted' } },
  { key: 'inventory', name: 'inventory-service', version: '1.9.7', latency: [15, 60], errorRate: 0.01,
    baseError: { status: 500, message: 'stock row lock timeout' } },
  { key: 'payment', name: 'payment-service', version: '4.0.2', latency: [40, 150], errorRate: 0.02,
    baseError: { status: 402, message: 'card declined' } },
  { key: 'notification', name: 'notification-service', version: '0.9.3', latency: [10, 50], errorRate: 0.02,
    baseError: { status: 503, message: 'smtp relay unavailable' } },
  { key: 'shipping', name: 'shipping-service', version: '1.5.0', latency: [20, 90], errorRate: 0.01,
    baseError: { status: 500, message: 'label provider returned malformed response' } },
  { key: 'search', name: 'search-service', version: '2.1.6', latency: [25, 120], errorRate: 0.01,
    baseError: { status: 504, message: 'elasticsearch query timeout' } },
  { key: 'recommendation', name: 'recommendation-service', version: '0.7.8', latency: [60, 250], errorRate: 0.015,
    baseError: { status: 500, message: 'model inference failed: feature store miss' } },
];

module.exports = { PROFILES };
