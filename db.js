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

module.exports = { pool, query };
