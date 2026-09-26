// Local password administration script (100% local, no email or external service required)
// Usage: node scripts/set-password.js <email> <newPassword>

const db = require('../db');
const { hashPassword } = require('../auth');

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Usage: node scripts/set-password.js <email> <newPassword>');
    process.exit(1);
  }

  const [email, newPassword] = args;
  const hash = await hashPassword(newPassword);

  const res = await db.query(
    `UPDATE users 
     SET password_hash = $1, 
         email_verified_at = COALESCE(email_verified_at, now()),
         token_version = token_version + 1
     WHERE LOWER(email) = LOWER($2)
     RETURNING id, email, display_name`,
    [hash, email.trim()]
  );

  if (res.rows.length === 0) {
    console.error(`[ERROR] User with email '${email}' not found in local database.`);
    process.exit(1);
  }

  console.log(`[SUCCESS] Password updated for ${res.rows[0].email} (User ID: ${res.rows[0].id})`);
  await db.pool.end();
}

main().catch(err => {
  console.error('Failed to set password:', err);
  process.exit(1);
});
