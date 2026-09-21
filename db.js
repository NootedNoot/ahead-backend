// One shared connection pool for the whole process. Every query in this
// codebase goes through query() below with parameterized placeholders
// ($1, $2, ...) - never string-concatenated SQL, this holds real health
// data. Supabase's pooled connection string already handles pooling on its
// end; `pg.Pool` here just avoids opening a fresh TCP connection per request.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// 2026-08-27: was `{ rejectUnauthorized: false }` - TLS was on but the
// server certificate was never actually verified, so the Railway<->Supabase
// link was encrypted but not authenticated (MITM-able in principle, found
// during a security pass). Fixed with Supabase's own project CA cert
// (downloaded from Dashboard -> Database Settings -> SSL Configuration,
// committed here as supabase-ca.crt - it's a public certificate, not a
// secret, safe to have in the repo) so the connection now does real
// verify-full-style validation instead of trust-on-connect.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: true,
    ca: fs.readFileSync(path.join(__dirname, 'supabase-ca.crt'), 'utf8'),
  },
});

function query(text, params) {
  return pool.query(text, params);
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn((text, params) => client.query(text, params));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function ensureSchema() {
  if (!process.env.DATABASE_URL) {
    return;
  }
  const migrations = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT false;`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS dob DATE;`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS diagnosis_date DATE;`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS target_low INTEGER DEFAULT 70;`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS target_high INTEGER DEFAULT 180;`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS units TEXT DEFAULT 'mg/dL';`,
    `ALTER TABLE device_keys ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'uploader';`,
  ];

  for (const sql of migrations) {
    try {
      await pool.query(sql);
    } catch (err) {
      console.warn('[DB] ensureSchema notice:', sql.trim(), err.message);
    }
  }
  console.log('[DB] Database schema migration check complete.');
}

module.exports = { pool, query, transaction, ensureSchema };
