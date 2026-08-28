const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { hashPassword, verifyPassword, signAdminToken, requireAdmin, logAuthEvent, clientIp, verifyInviteSecret } = require('../auth');
const asyncHandler = require('../lib/asyncHandler');
const { isValidEmail } = require('../lib/validators');

const router = express.Router();

// --- Admin login - fully separate from user login, see auth.js's doc ----
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const ip = clientIp(req);

  const { rows } = await db.query('SELECT id, email, password_hash FROM admins WHERE email = $1', [email || '']);
  const admin = rows[0];
  const ok = admin && typeof password === 'string' && await verifyPassword(password, admin.password_hash);

  await logAuthEvent({ email: email || '', userId: null, isAdminAttempt: true, success: !!ok, ip });
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  res.json({ token: signAdminToken(admin), admin: { id: admin.id, email: admin.email } });
}));

router.use(requireAdmin);

// --- Admin management -------------------------------------------------
// No self-serve admin signup, ever - this is the ONLY way an admin gets
// created besides the CLI seed script, and it's deliberately harder than
// anything else in this codebase: it needs (1) an already-valid admin
// session, (2) that admin's OWN password re-entered (proves a live human
// typed it just now, not a replayed/stolen bearer token), and (3) a
// separate ADMIN_INVITE_SECRET that exists ONLY as a Railway env var - no
// admin session, however real, is enough on its own. A short, extra rate
// limit on top since this is the single most sensitive action in the app.
const createAdminLimiter = rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false });

router.get('/admins', asyncHandler(async (req, res) => {
  const { rows } = await db.query('SELECT id, email, created_at FROM admins ORDER BY created_at ASC');
  res.json(rows.map(r => ({ id: r.id, email: r.email, createdAt: r.created_at })));
}));

router.post('/admins', createAdminLimiter, asyncHandler(async (req, res) => {
  const { email, password, actingAdminPassword, inviteSecret, reason } = req.body || {};

  if (!isValidEmail(email) || typeof password !== 'string' || password.length < 10) {
    return res.status(400).json({ error: 'Valid email and a password of at least 10 characters are required' });
  }
  if (!verifyInviteSecret(inviteSecret)) {
    return res.status(403).json({ error: 'Missing or incorrect invite secret' });
  }

  const { rows: selfRows } = await db.query('SELECT password_hash FROM admins WHERE id = $1', [req.admin.id]);
  const selfOk = typeof actingAdminPassword === 'string' && await verifyPassword(actingAdminPassword, selfRows[0].password_hash);
  if (!selfOk) {
    return res.status(403).json({ error: 'Your own password is required to create a new admin' });
  }

  const existing = await db.query('SELECT id FROM admins WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'An admin with that email already exists' });
  }

  const passwordHash = await hashPassword(password);
  const { rows } = await db.query(
    'INSERT INTO admins (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
    [email, passwordHash],
  );
  await db.query(
    `INSERT INTO admin_audit_log (admin_id, action, reason) VALUES ($1, 'create_admin', $2)`,
    [req.admin.id, `Created new admin ${email}${reason ? ' — ' + reason : ''}`],
  );

  res.status(201).json({ id: rows[0].id, email: rows[0].email, createdAt: rows[0].created_at });
}));

// --- User management ------------------------------------------------
router.get('/users', asyncHandler(async (req, res) => {
  const search = (req.query.search || '').trim();
  const status = req.query.status;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = 50;

  const conditions = [];
  const params = [];
  if (search) { params.push(`%${search}%`); conditions.push(`u.email ILIKE $${params.length}`); }
  if (status === 'active' || status === 'disabled') { params.push(status); conditions.push(`u.status = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: countRows } = await db.query(`SELECT COUNT(*) FROM users u ${where}`, params);
  params.push(pageSize, (page - 1) * pageSize);
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.display_name, u.status, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM device_keys dk WHERE dk.user_id = u.id AND dk.revoked_at IS NULL) AS device_count
     FROM users u ${where}
     ORDER BY u.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  res.json({
    total: parseInt(countRows[0].count, 10),
    users: rows.map(r => ({
      id: r.id, email: r.email, displayName: r.display_name, status: r.status,
      createdAt: r.created_at, lastLoginAt: r.last_login_at, deviceCount: parseInt(r.device_count, 10),
    })),
  });
}));

router.get('/users/:id', asyncHandler(async (req, res) => {
  const { rows: userRows } = await db.query(
    'SELECT id, email, display_name, status, created_at, last_login_at, disabled_at, email_verified_at FROM users WHERE id = $1',
    [req.params.id],
  );
  if (userRows.length === 0) return res.status(404).json({ error: 'User not found' });

  const { rows: devices } = await db.query(
    `SELECT id, label, key_prefix, created_at, last_used_at, revoked_at
     FROM device_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.params.id],
  );
  const { rows: events } = await db.query(
    `SELECT success, ip_address, created_at FROM auth_events
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.params.id],
  );

  const u = userRows[0];
  res.json({
    user: {
      id: u.id, email: u.email, displayName: u.display_name, status: u.status,
      createdAt: u.created_at, lastLoginAt: u.last_login_at, disabledAt: u.disabled_at,
      emailVerifiedAt: u.email_verified_at,
    },
    devices: devices.map(d => ({
      deviceId: d.id, label: d.label, keyPrefix: d.key_prefix,
      createdAt: d.created_at, lastUsedAt: d.last_used_at, revoked: d.revoked_at !== null,
    })),
    recentAuthEvents: events.map(e => ({ success: e.success, ip: e.ip_address, at: e.created_at })),
  });
}));

// --- Access control (every action writes an audit row) --------------
async function disableUser(adminId, userId, reason) {
  const { rows } = await db.query(
    `UPDATE users SET status = 'disabled', disabled_at = now() WHERE id = $1 AND status = 'active' RETURNING id`,
    [userId],
  );
  if (rows.length === 0) return false;
  await db.query(
    `INSERT INTO admin_audit_log (admin_id, action, target_user_id, reason) VALUES ($1, 'disable_user', $2, $3)`,
    [adminId, userId, reason || null],
  );
  return true;
}

router.post('/users/:id/disable', asyncHandler(async (req, res) => {
  const ok = await disableUser(req.admin.id, req.params.id, req.body?.reason);
  if (!ok) return res.status(404).json({ error: 'User not found or already disabled' });
  res.json({ disabled: true });
}));

router.post('/users/:id/enable', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE users SET status = 'active', disabled_at = NULL WHERE id = $1 AND status = 'disabled' RETURNING id`,
    [req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'User not found or already active' });
  await db.query(
    `INSERT INTO admin_audit_log (admin_id, action, target_user_id, reason) VALUES ($1, 'enable_user', $2, $3)`,
    [req.admin.id, req.params.id, req.body?.reason || null],
  );
  res.json({ enabled: true });
}));

router.post('/users/bulk-disable', asyncHandler(async (req, res) => {
  const { userIds, reason } = req.body || {};
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ error: 'userIds must be a non-empty array' });
  }
  let disabled = 0;
  for (const userId of userIds) {
    if (await disableUser(req.admin.id, userId, reason)) disabled += 1;
  }
  res.json({ disabled });
}));

router.post('/devices/:id/revoke', asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE device_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id, user_id`,
    [req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Device key not found or already revoked' });
  await db.query(
    `INSERT INTO admin_audit_log (admin_id, action, target_user_id, target_device_id, reason)
     VALUES ($1, 'revoke_device', $2, $3, $4)`,
    [req.admin.id, rows[0].user_id, req.params.id, req.body?.reason || null],
  );
  res.json({ revoked: true });
}));

// --- Audit trail ------------------------------------------------------
router.get('/audit-log', asyncHandler(async (req, res) => {
  const conditions = [];
  const params = [];
  if (req.query.userId) { params.push(req.query.userId); conditions.push(`l.target_user_id = $${params.length}`); }
  if (req.query.adminId) { params.push(req.query.adminId); conditions.push(`l.admin_id = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Math.min(parseInt(req.query.limit, 10) || 100, 500));

  const { rows } = await db.query(
    `SELECT l.id, l.action, l.reason, l.created_at,
            a.email AS admin_email, tu.email AS target_user_email
     FROM admin_audit_log l
     JOIN admins a ON a.id = l.admin_id
     LEFT JOIN users tu ON tu.id = l.target_user_id
     ${where}
     ORDER BY l.created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  res.json(rows.map(r => ({
    id: r.id, action: r.action, reason: r.reason, at: r.created_at,
    adminEmail: r.admin_email, targetUserEmail: r.target_user_email,
  })));
}));

// --- Abuse/security visibility - query-time, no stored counters ------
router.get('/security/failed-logins', asyncHandler(async (req, res) => {
  const conditions = ['success = false'];
  const params = [];
  if (req.query.userId) { params.push(req.query.userId); conditions.push(`user_id = $${params.length}`); }
  if (req.query.ip) { params.push(req.query.ip); conditions.push(`ip_address = $${params.length}`); }
  if (req.query.since) { params.push(req.query.since); conditions.push(`created_at >= $${params.length}`); }
  params.push(Math.min(parseInt(req.query.limit, 10) || 100, 500));

  const { rows } = await db.query(
    `SELECT email_attempted, user_id, is_admin_attempt, ip_address, created_at
     FROM auth_events WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  res.json(rows.map(r => ({
    email: r.email_attempted, userId: r.user_id, isAdminAttempt: r.is_admin_attempt,
    ip: r.ip_address, at: r.created_at,
  })));
}));

router.get('/security/rate-limit-hits', asyncHandler(async (req, res) => {
  const conditions = [];
  const params = [];
  if (req.query.ip) { params.push(req.query.ip); conditions.push(`ip_address = $${params.length}`); }
  if (req.query.since) { params.push(req.query.since); conditions.push(`created_at >= $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await db.query(
    `SELECT ip_address, endpoint, COUNT(*) AS hits, MAX(created_at) AS last_hit
     FROM rate_limit_hits ${where}
     GROUP BY ip_address, endpoint
     ORDER BY hits DESC LIMIT 200`,
    params,
  );
  res.json(rows.map(r => ({ ip: r.ip_address, endpoint: r.endpoint, hits: parseInt(r.hits, 10), lastHit: r.last_hit })));
}));

// Fixed threshold, not tuned, not ML - a starting point the owner can
// eyeball and act on (disable the account, or just note it). >=5 failed
// logins in the trailing hour, grouped by whichever identity is more
// specific (email if it matched a real account, else the raw attempted
// email/IP pairing).
router.get('/security/flags', asyncHandler(async (req, res) => {
  const { rows: byEmail } = await db.query(
    `SELECT email_attempted, COUNT(*) AS failed_count, MIN(created_at) AS window_start
     FROM auth_events
     WHERE success = false AND created_at >= now() - interval '1 hour'
     GROUP BY email_attempted HAVING COUNT(*) >= 5`,
  );
  const { rows: byIp } = await db.query(
    `SELECT ip_address, COUNT(*) AS failed_count, MIN(created_at) AS window_start
     FROM auth_events
     WHERE success = false AND created_at >= now() - interval '1 hour' AND ip_address IS NOT NULL
     GROUP BY ip_address HAVING COUNT(*) >= 5`,
  );
  res.json([
    ...byEmail.map(r => ({ type: 'email', value: r.email_attempted, failedCount: parseInt(r.failed_count, 10), windowStart: r.window_start })),
    ...byIp.map(r => ({ type: 'ip', value: r.ip_address, failedCount: parseInt(r.failed_count, 10), windowStart: r.window_start })),
  ]);
}));

module.exports = router;
