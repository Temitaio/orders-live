const express = require('express');
const { ROOT_CONTEXT } = require('@opentelemetry/api');
const telemetry = require('./telemetry');
const scenarios = require('./scenarios');
const engine = require('./engine');
const journeys = require('./journeys');
const { PROFILES } = require('./profiles');

// opts.telemetry is passed to telemetry.init (used by tests to capture in memory).
function create(opts = {}) {
  const tel = telemetry.init(opts.telemetry);
  const S = {};
  for (const p of PROFILES) S[p.key] = tel.createService(p);

  let inflight = 0;
  let loopTimer = null;
  let rotationTimer = null;
  let lastLogged = 'normal';

  const runJourney = (name) => {
    const j = journeys.journeys[name];
    if (!j) throw new Error(`unknown journey: ${name}`);
    return j.run(S);
  };

  function activate(name, minutes) {
    const cur = scenarios.set(name, minutes);
    announce(cur);
    return cur;
  }

  function announce(cur) {
    if (cur.name === lastLogged) return;
    const msg = cur.name === 'normal' ? `scenario ended (was ${lastLogged})` : `scenario started: ${cur.name}`;
    engine.log(S.gateway, ROOT_CONTEXT, 'info', msg, { 'sim.scenario': cur.name });
    console.log(`[sim] ${msg}`);
    lastLogged = cur.name;
  }

  function start({ ordersBase } = {}) {
    if (ordersBase) engine.configure({ ordersBase });
    const base = Number(process.env.SIM_RATE_PER_MIN || 20);

    const loop = () => {
      const rate = Math.max(1, base * scenarios.current().rateMult);
      const wait = (60000 / rate) * (0.5 + Math.random());
      loopTimer = setTimeout(() => {
        if (inflight < 60) {
          inflight++;
          runJourney(journeys.pick())
            .catch((e) => console.log('[sim] journey failed:', e.message))
            .finally(() => inflight--);
        }
        loop();
      }, wait);
    };
    loop();

    // Automatic scenario rotation: normal for a while, then a random incident for 3-6 minutes.
    let nextRotate = Date.now() + engine.rand(3, 5) * 60000;
    rotationTimer = setInterval(() => {
      announce(scenarios.current());
      if (process.env.SCENARIO_ROTATION === 'false') return;
      if (scenarios.current().name === 'normal' && Date.now() > nextRotate) {
        const choices = scenarios.names().filter((n) => n !== 'normal');
        const name = choices[engine.rand(0, choices.length - 1)];
        const minutes = engine.rand(3, 6);
        activate(name, minutes);
        nextRotate = Date.now() + (minutes + engine.rand(6, 12)) * 60000;
      }
    }, 15000);

    console.log(`[sim] ${PROFILES.length} virtual services running, ~${base} journeys/min, orders-live at ${ordersBase}`);
  }

  function stop() {
    clearTimeout(loopTimer);
    clearInterval(rotationTimer);
  }

  const router = express.Router();
  const guard = (req, res, next) => {
    const token = process.env.SIM_ADMIN_TOKEN;
    if (token && req.get('x-admin-token') !== token) return res.status(401).json({ error: 'unauthorized' });
    next();
  };

  router.get('/status', (req, res) =>
    res.json({
      scenario: scenarios.current(),
      services: ['orders-live', ...PROFILES.map((p) => p.name)],
      journeys: journeys.names,
      journeysPerMinute: Number(process.env.SIM_RATE_PER_MIN || 20),
      rotation: process.env.SCENARIO_ROTATION !== 'false',
      inflight,
    })
  );
  router.get('/scenarios', (req, res) => res.json(scenarios.list()));
  router.post('/scenario/:name', guard, (req, res) => {
    const minutes = Math.min(60, Math.max(1, Number(req.query.minutes) || 5));
    try {
      res.json(activate(req.params.name, minutes));
    } catch (e) {
      res.status(404).json({ error: e.message, available: scenarios.names() });
    }
  });

  return { S, router, start, stop, runJourney, activate, flush: tel.flush, configure: engine.configure };
}

module.exports = { create };
