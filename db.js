// One shared connection pool for the whole process. Every query in this
// codebase goes through query() below with parameterized placeholders
// ($1, $2, ...) - never string-concatenated SQL, this holds real health
// data. Supabase's pooled connection string already handles pooling on its
// end; `pg.Pool` here just avoids opening a fresh TCP connection per request.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase requires TLS; Railway's outbound network doesn't carry Supabase's CA bundle, so we trust-on-connect rather than pin it
});

function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };
