# orders-live

A small "shop" for testing Monoscope end to end: one real app (Express + Neon Postgres) plus nine simulated services that call each other and the real app, all instrumented with OpenTelemetry (traces, logs, metrics over gRPC).

## Services (10 in Monoscope)

| Service | Role |
|---|---|
| `orders-live` | The real Express app with real Neon Postgres spans |
| `api-gateway` | Entry point; roots every trace |
| `auth-service` | Session verify / login (Redis + Postgres spans) |
| `user-service` | Profiles (Postgres) |
| `inventory-service` | Stock reservation (Postgres, row locks) |
| `payment-service` | Charges via a Stripe-style external call, with retries |
| `notification-service` | Emails via an external SMTP call |
| `shipping-service` | Labels and tracking (Postgres) |
| `search-service` | Product search (Elasticsearch spans) |
| `recommendation-service` | Recommendations (feature store, ML predict, calls inventory) |

The nine virtual services run inside the same Node process. Each has its own tracer, logger and meter with its own `service.name`, so Monoscope treats them as separate services, with trace context passed between them. Calls from the gateway to `orders-live` are real HTTP requests that carry `traceparent`, so real Postgres spans appear inside the same traces.

## Journeys (traces)

`checkout` (auth, user, inventory, payment with retry, real `POST /orders`, then shipping and notification in parallel), `browse` (search, recommendations, inventory), `login`, `orderStatus` (real `GET /orders/:id`), `adminReport` (real `/report`), and diagnostics through the gateway to the real `/slow`, `/flaky` and `/error`.

## Scenarios (incidents)

The simulator rotates through these automatically (normal for ~3-5 minutes, then a random incident for 3-6 minutes). Set `SCENARIO_ROTATION=false` to stop that and trigger them yourself.

| Scenario | What happens |
|---|---|
| `normal` | Baseline noise only |
| `payment_outage` | payment-service errors ~80% and slow; checkout retries |
| `slow_inventory` | inventory-service 10x slower; latency cascades |
| `auth_degraded` | auth-service 30% errors, 4x latency |
| `notification_down` | emails fail (warnings; checkouts still succeed) |
| `search_degraded` | search 8x slower with 10% gateway timeouts |
| `shipping_rate_limited` | 40% HTTP 429 from shipping |
| `black_friday` | 4x traffic, slower everywhere, extra errors |

Control endpoints (on your Render URL):

```bash
curl https://YOUR-APP.onrender.com/sim/status
curl https://YOUR-APP.onrender.com/sim/scenarios
curl -X POST "https://YOUR-APP.onrender.com/sim/scenario/payment_outage?minutes=5"
curl -X POST "https://YOUR-APP.onrender.com/sim/scenario/normal"
```

If you set `SIM_ADMIN_TOKEN` in Render, add `-H "x-admin-token: YOUR_TOKEN"` to the POST calls. Start and end of each scenario is also logged by `api-gateway` (search logs for `scenario`).

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | Neon connection string |
| `OTEL_RESOURCE_ATTRIBUTES` | required | `x-api-key=YOUR_KEY,deployment.environment=production` (one line) |
| `SIMULATE` | `true` | `false` turns off all virtual services |
| `SIM_RATE_PER_MIN` | `20` | Journeys per minute (each is ~8-20 spans) |
| `SCENARIO_ROTATION` | `true` | Auto-rotate incidents |
| `SIM_ADMIN_TOKEN` | unset | Protects `POST /sim/scenario/*` |
| `SIM_VERBOSE` | `false` | Print virtual-service logs to the console |

## Deploy updates

Render redeploys automatically on every push to `main`:

```bash
git add -A && git commit -m "Add simulated services" && git push
```

## Run locally

```bash
npm install
cp .env.example .env     # fill in DATABASE_URL and your Monoscope key
set -a; source .env; set +a
npm start
npm test                 # in-memory check of the simulation, no keys needed
```

## What to look for in Monoscope

The service map with 10 nodes, traces spanning 5-8 services, per-service latency and error rates, retries in checkout traces, logs correlated to traces, and a visible shift in the charts whenever a scenario starts.

## Notes

- Free Render instances sleep after ~15 minutes without inbound traffic. Calls to `orders-live` go through the public URL, which keeps it awake. If it still sleeps, ping `/health` from an uptime monitor.
- Raising `SIM_RATE_PER_MIN` raises your Monoscope event volume. At the default of 20, expect roughly 200-400 spans per minute.
- The table keeps only the latest ~1000 orders.
- If you get a `channel_binding` error from Neon, remove `&channel_binding=require` from the connection string.
