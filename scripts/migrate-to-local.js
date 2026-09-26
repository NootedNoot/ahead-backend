const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function migrate() {
  const client = new Client({
    host: '127.0.0.1',
    port: 5432,
    user: 'postgres',
    database: 'ahead'
  });
  await client.connect();
  console.log('Connected to local ahead database.');

  // Apply schema
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await client.query(schemaSql);
  console.log('Schema applied successfully.');

  // Load backup
  const backupFile = path.join(__dirname, '..', 'backup', 'supabase_data_export.json');
  const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));

  // 1. Users
  for (const u of backup.users) {
    await client.query(
      `INSERT INTO users (id, email, password_hash, display_name, status, disabled_at, last_login_at, created_at, email_verified_at, token_version, is_owner, dob, diagnosis_date, target_low, target_high, units)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now()), $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (id) DO NOTHING`,
      [
        u.id, u.email, u.password_hash, u.display_name, u.status, u.disabled_at, u.last_login_at, u.created_at,
        u.email_verified_at, u.token_version || 0, u.is_owner || false, u.dob, u.diagnosis_date, u.target_low || 70, u.target_high || 180, u.units || 'mg/dL'
      ]
    );
  }
  console.log('Restored', backup.users.length, 'users (all marked verified).');

  // 2. Device keys
  for (const k of backup.deviceKeys) {
    await client.query(
      `INSERT INTO device_keys (id, user_id, key_hash, key_prefix, label, created_at, last_used_at, revoked_at, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [k.id, k.user_id, k.key_hash, k.key_prefix, k.label, k.created_at, k.last_used_at, k.revoked_at, k.role || 'uploader']
    );
  }
  console.log('Restored', backup.deviceKeys.length, 'device keys.');

  // 3. Shares
  for (const s of backup.shares) {
    await client.query(
      `INSERT INTO shares (id, owner_id, viewer_id, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [s.id, s.owner_id, s.viewer_id, s.created_at]
    );
  }
  console.log('Restored', backup.shares.length, 'shares.');

  // 4. Readings
  console.log('Inserting', backup.readings.length, 'readings...');
  const batchSize = 200;
  for (let i = 0; i < backup.readings.length; i += batchSize) {
    const chunk = backup.readings.slice(i, i + batchSize);
    for (const r of chunk) {
      await client.query(
        `INSERT INTO readings (user_id, reading_time_ms, sgv, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, reading_time_ms) DO NOTHING`,
        [r.user_id, r.reading_time_ms, r.sgv, r.created_at]
      );
    }
    process.stdout.write(`\rProgress: ${Math.min(i + batchSize, backup.readings.length)} / ${backup.readings.length}`);
  }
  console.log('\nRestored all readings successfully!');

  const countRes = await client.query('SELECT count(*) FROM readings');
  console.log('TOTAL READINGS IN LOCAL POSTGRES:', countRes.rows[0].count);

  await client.end();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
