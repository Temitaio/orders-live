# orders-live: Monoscope Demo Console

An OpenTelemetry-instrumented demo shop (10 services, Postgres on Neon) with a browser **Demo Console** so anyone can show Monoscope end to end without a terminal.

## Using the console (non-technical)
1. Open the app URL. If a passcode is set, enter it. (Free hosting sleeps: open the link ~5 minutes before a demo.)
2. In Monoscope, copy your project's **API key**, paste it in step 1, click **Connect**.
3. Click buttons in step 2 (traffic, errors, slow requests, incidents).
4. Click **Open Monoscope** and watch events arrive.
5. **Disconnect** when done (the key is forgotten; idle sessions end after 10 minutes).

The status line shows whether Monoscope's collector accepted the data. It proves the collector took the batches, not that the key belongs to the project you are viewing.

## Modes (`DEMO_MODE`)
| Mode | Behavior | Neon / Render cost |
|---|---|---|
| `console` | Nothing runs until someone connects a key. | Lowest. Service can sleep. |
| `burst` (default in render.yaml) | One ~60 s burst every `SIM_BURST_EVERY_MINUTES` (15) using the key in `OTEL_RESOURCE_ATTRIBUTES`. About 30% of bursts include an incident. | Neon is active roughly 40% of the time. |
| `continuous` | Steady traffic plus rotating incidents. | Exhausts Neon free compute. Avoid. |

A console connection temporarily replaces the baseline, then restores it on disconnect.

## Free-tier math
- **Neon** free: 100 CU-hours/month. Each burst keeps compute awake about 6 minutes (60 s of traffic plus the 5-minute idle suspend), so a 15-minute interval is active ~40% of the time. At 0.25 CU that is about 74 CU-hours/month. Check the Neon usage page; use 20 to 30 minutes for margin. Health checks (`/health`) never query the database, and the schema is created lazily.
- **Render** free: 750 instance-hours/month. Burst mode keeps the service awake (self-ping every 10 min), about 744 hours for one service. Use `console` mode if you also run other free services.

## Settings
`DATABASE_URL` (required), `DEMO_MODE`, `OTEL_RESOURCE_ATTRIBUTES` (`x-api-key=KEY,deployment.environment=production`, needed for burst/continuous), `DEMO_PASSCODE` (optional), `SIM_BURST_EVERY_MINUTES`, `SIM_BURST_JOURNEYS`, `SIM_BURST_SECONDS`, `SIM_IDLE_MINUTES` (10), `SESSION_MAX_MINUTES` (120), `MONOSCOPE_URL`.
Collector: `http://otelcol.monoscope.tech:4317` over gRPC; the key travels as the `x-api-key` resource attribute.

## Run locally
```
cp .env.example .env   # fill in, keep the quotes
npm install
set -a; source .env; set +a
npm start        # Demo Console on http://localhost:3000
npm run app      # just the instrumented app, no console
npm test         # in-memory telemetry checks, no network needed
```
