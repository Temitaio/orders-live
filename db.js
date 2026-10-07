const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Paste your Neon connection string into it (see README).');
  process.exit(1);
}

// Neon connection strings include ?sslmode=require, which pg honors.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
});

// The schema is created lazily on the first real query, so starting the app (or waking
// the host) never touches the database. This lets Neon's compute suspend when idle.
let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = pool
      .query(`
        CREATE TABLE IF NOT EXISTS orders (
          id          SERIAL PRIMARY KEY,
          customer    TEXT        NOT NULL,
          total_cents INTEGER     NOT NULL,
          status      TEXT        NOT NULL DEFAULT 'pending',
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      .catch((e) => {
        schemaPromise = null;
        throw e;
      });
  }
  return schemaPromise;
}

async function query(text, params) {
  await ensureSchema();
  return pool.query(text, params);
}

module.exports = { pool, query, ensureSchema };
