# orders-live

Express API backed by Neon Postgres, instrumented with OpenTelemetry (traces, logs, metrics over gRPC) for Monoscope. A built-in simulator calls the app on a random cadence so events keep flowing once it's hosted.

## Endpoints

| Endpoint | What it produces |
|---|---|
| `GET /health` | Fast request plus a `SELECT 1` DB span |
| `GET /orders`, `GET /orders/:id` | Normal reads (404s for missing ids) |
| `POST /orders` | DB insert, counter and histogram metrics, log line |
| `GET /report` | Aggregate query |
| `GET /slow` | Real 200ms-3s latency via `pg_sleep` |
| `GET /flaky` | ~30% 500s |
| `GET /error` | A genuine Postgres error, recorded on the span |

## 1. Create the database (Neon)

1. Create a project at neon.tech.
2. In the dashboard, click Connect and copy the connection string.
3. The app creates its `orders` table on startup. Nothing else to set up.

## 2. Run locally (optional)

```bash
npm install
cp .env.example .env     # fill in DATABASE_URL and your Monoscope API key
set -a; source .env; set +a
npm start
```

## 3. Deploy to Render

1. Push this folder to a GitHub repo.
2. In Render: New > Blueprint, pick the repo (it reads `render.yaml`).
3. When prompted, set the two secret env vars:
   - `DATABASE_URL`: your Neon connection string.
   - `OTEL_RESOURCE_ATTRIBUTES`: `x-api-key=YOUR_MONOSCOPE_API_KEY,deployment.environment=production`
4. Deploy. Logs should show `[otel] started`, `listening`, and `[sim] simulator running`.

## What to check in Monoscope

Service `orders-live`: traces with real `pg` child spans, logs correlated to traces, grouped errors (relation does not exist, flaky timeout), latency from `/slow`, and the `orders.created` / `orders.value` metrics.

## Notes

- Free Render instances spin down after ~15 minutes without inbound traffic. The simulator calls the app's public `RENDER_EXTERNAL_URL`, which counts as inbound traffic and keeps it awake, but if it still sleeps, ping `/health` from an uptime monitor.
- Set `SIMULATE=false` to stop the simulator. The table keeps only the latest ~1000 orders.
- If you get a `channel_binding` error from Neon, remove `&channel_binding=require` from the connection string.
