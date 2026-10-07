// User journeys: each one is a trace that fans out across the virtual services and,
// where it makes sense, into the real orders-live app (with its Postgres spans).
const { rand, sleep, SimError, log, rpc, entry, work, db, external, callOrders } = require('./engine');

const verifySession = (S, ctx) =>
  rpc(ctx, S.gateway, S.auth, {
    route: '/v1/session/verify',
    handler: (c) => db(S.auth, c, 'redis', 'GET session', 'GET session:*', rand(1, 6)),
  });

const getUser = (S, ctx) =>
  rpc(ctx, S.gateway, S.user, {
    route: '/v1/users/{id}',
    handler: (c) =>
      db(S.user, c, 'postgresql', 'SELECT users', 'SELECT * FROM users WHERE id = $1', rand(3, 20)),
  });

// Payment with one retry on 5xx (card declines, i.e. 4xx, are not retried).
async function chargeWithRetry(S, ctx) {
  let last;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await rpc(ctx, S.gateway, S.payment, {
        method: 'POST',
        route: '/v1/charges',
        handler: (c) => external(S.payment, c, 'api.stripe.com', 'POST', '/v1/charges', rand(60, 220)),
      });
    } catch (err) {
      last = err;
      if (err.status < 500) break;
      log(S.gateway, ctx, 'warn', `payment attempt ${attempt} failed, ${attempt < 2 ? 'retrying' : 'giving up'}`, {
        'retry.attempt': attempt,
        'error.message': err.message,
      });
      if (attempt < 2) await sleep(rand(100, 300));
    }
  }
  throw last;
}

const journeys = {
  checkout: {
    weight: 3,
    run: (S) =>
      entry(S, 'POST', '/api/checkout', async (ctx) => {
        await verifySession(S, ctx);
        await getUser(S, ctx);
        await rpc(ctx, S.gateway, S.inventory, {
          method: 'POST',
          route: '/v1/reservations',
          handler: async (c) => {
            await db(S.inventory, c, 'postgresql', 'SELECT stock', 'SELECT quantity FROM stock WHERE sku = $1 FOR UPDATE', rand(5, 30));
            await db(S.inventory, c, 'postgresql', 'UPDATE stock', 'UPDATE stock SET reserved = reserved + $2 WHERE sku = $1', rand(5, 25));
          },
        });
        await chargeWithRetry(S, ctx);
        await callOrders(ctx, S.gateway, 'POST', '/orders', '/orders', {});
        // Fulfilment side effects run in parallel; failures here degrade gracefully.
        const [label, email] = await Promise.allSettled([
          rpc(ctx, S.gateway, S.shipping, {
            method: 'POST',
            route: '/v1/labels',
            handler: (c) => db(S.shipping, c, 'postgresql', 'INSERT labels', 'INSERT INTO labels (order_id, carrier) VALUES ($1, $2)', rand(5, 30)),
          }),
          rpc(ctx, S.gateway, S.notification, {
            method: 'POST',
            route: '/v1/emails',
            handler: (c) => external(S.notification, c, 'smtp.mailprovider.example', 'POST', '/send', rand(30, 150)),
          }),
        ]);
        if (label.status === 'rejected') log(S.gateway, ctx, 'warn', 'shipping label delayed, queued for retry', { 'error.message': label.reason.message });
        if (email.status === 'rejected') log(S.gateway, ctx, 'warn', 'confirmation email not sent', { 'error.message': email.reason.message });
      }),
  },

  browse: {
    weight: 6,
    run: (S) =>
      entry(S, 'GET', '/api/products', async (ctx) => {
        await rpc(ctx, S.gateway, S.search, {
          route: '/v1/search',
          handler: (c) =>
            db(S.search, c, 'elasticsearch', 'search products', '{"query":{"match":{"title":"widget"}},"size":20}', rand(15, 90)),
        });
        try {
          await rpc(ctx, S.gateway, S.recommendation, {
            route: '/v1/recommendations',
            handler: async (c) => {
              await work(S.recommendation, c, 'feature_store.lookup', rand(5, 25));
              await rpc(c, S.recommendation, S.inventory, {
                route: '/v1/stock',
                handler: (c2) =>
                  db(S.inventory, c2, 'postgresql', 'SELECT stock', 'SELECT sku, quantity FROM stock WHERE sku = ANY($1)', rand(5, 25)),
              });
              await work(S.recommendation, c, 'ml.model.predict', rand(30, 180), { 'ml.model': 'ranker-v3' });
            },
          });
        } catch (err) {
          log(S.gateway, ctx, 'warn', 'recommendations unavailable, serving default ranking', { 'error.message': err.message });
        }
      }),
  },

  login: {
    weight: 3,
    run: (S) =>
      entry(S, 'POST', '/api/login', async (ctx) => {
        await rpc(ctx, S.gateway, S.auth, {
          method: 'POST',
          route: '/v1/login',
          handler: async (c) => {
            await db(S.auth, c, 'postgresql', 'SELECT credentials', 'SELECT password_hash FROM credentials WHERE email = $1', rand(3, 15));
            await work(S.auth, c, 'bcrypt.compare', rand(60, 160));
            if (Math.random() < 0.08) throw new SimError(401, 'invalid credentials', S.auth.name);
            await db(S.auth, c, 'redis', 'SET session', 'SET session:* EX 3600', rand(1, 5));
          },
        });
        await rpc(ctx, S.gateway, S.user, {
          route: '/v1/users/{id}/profile',
          handler: (c) => db(S.user, c, 'postgresql', 'SELECT profiles', 'SELECT * FROM profiles WHERE user_id = $1', rand(3, 20)),
        });
      }),
  },

  orderStatus: {
    weight: 4,
    run: (S) =>
      entry(S, 'GET', '/api/orders/{id}', async (ctx) => {
        await verifySession(S, ctx);
        await callOrders(ctx, S.gateway, 'GET', `/orders/${rand(1, 300)}`, '/orders/{id}');
        await rpc(ctx, S.gateway, S.shipping, {
          route: '/v1/tracking/{order_id}',
          handler: (c) => db(S.shipping, c, 'postgresql', 'SELECT shipments', 'SELECT * FROM shipments WHERE order_id = $1', rand(5, 30)),
        });
      }),
  },

  adminReport: {
    weight: 1,
    run: (S) =>
      entry(S, 'GET', '/api/admin/report', async (ctx) => {
        await verifySession(S, ctx);
        await callOrders(ctx, S.gateway, 'GET', '/report', '/report');
        await rpc(ctx, S.gateway, S.shipping, {
          route: '/v1/stats',
          handler: (c) => db(S.shipping, c, 'postgresql', 'SELECT shipments', 'SELECT carrier, count(*) FROM shipments GROUP BY carrier', rand(20, 80)),
        });
      }),
  },

  // Direct diagnostics through the gateway to the real app: slow queries, flaky and failing routes.
  diagSlow: {
    weight: 1,
    run: (S) => entry(S, 'GET', '/api/diagnostics/slow', (ctx) => callOrders(ctx, S.gateway, 'GET', '/slow', '/slow')),
  },
  diagFlaky: {
    weight: 1,
    run: (S) => entry(S, 'GET', '/api/diagnostics/flaky', (ctx) => callOrders(ctx, S.gateway, 'GET', '/flaky', '/flaky')),
  },
  diagError: {
    weight: 1,
    run: (S) => entry(S, 'GET', '/api/diagnostics/error', (ctx) => callOrders(ctx, S.gateway, 'GET', '/error', '/error')),
  },
};

const names = Object.keys(journeys);
const totalWeight = names.reduce((n, k) => n + journeys[k].weight, 0);

function pick() {
  let r = Math.random() * totalWeight;
  for (const k of names) {
    r -= journeys[k].weight;
    if (r <= 0) return k;
  }
  return names[0];
}

module.exports = { journeys, names, pick };
