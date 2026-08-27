// One-time script to create the first (and any later) admin account.
// There's no signup endpoint for admins on purpose - this is the only way
// an admin row gets created.
//
// Usage (from the ahead-backend directory, with DATABASE_URL set):
//   node scripts/seed-admin.js you@example.com "a real password"
//
// Locally, set DATABASE_URL first (PowerShell):
//   $env:DATABASE_URL = "postgresql://...supabase connection string..."
//   node scripts/seed-admin.js you@example.com "a real password"
const bcrypt = require('bcrypt');
const db = require('../db');

async function main() {
  const [, , email, password] = process.argv;
  if (!email || !password) {
    console.error('Usage: node scripts/seed-admin.js <email> <password>');
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('Password must be at least 10 characters.');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const { rows } = await db.query(
    `INSERT INTO admins (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id, email`,
    [email, passwordHash],
  );
  console.log(`Admin ready: ${rows[0].email} (${rows[0].id})`);
  await db.pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
