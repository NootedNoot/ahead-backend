const express = require('express');
const db = require('../db');
const {
  hashPassword, verifyPassword, signUserToken, requireUser, logAuthEvent, clientIp,
  generateEmailToken, hashEmailToken,
} = require('../auth');
const asyncHandler = require('../lib/asyncHandler');
const { isValidEmail } = require('../lib/validators');
const { sendPasswordResetEmail, sendVerificationEmail, sendPasswordChangedEmail } = require('../lib/email');
const { verifyEmailLink, resetPasswordLink } = require('../lib/links');

const router = express.Router();

// Emailed links are built by lib/links.js: SITE_BASE_URL when set (the
// marketing site), else Railway's own public hostname exactly as before
// (RAILWAY_PUBLIC_DOMAIN, or localhost outside Railway). Never hardcoded.

const PASSWORD_RESET_EXPIRY_MS = 30 * 60_000;
const EMAIL_VERIFY_EXPIRY_MS = 24 * 60 * 60_000;
// Per-email throttle on top of the IP-based authLimiter server.js already
// applies to this whole router - an attacker with a rotating IP shouldn't
// be able to spam one person's inbox with reset emails.
const MAX_PENDING_TOKENS_PER_HOUR = 3;

async function issueEmailToken(userId, purpose) {
  const { raw, hash } = generateEmailToken();
  const expiresAt = new Date(Date.now() + (purpose === 'password_reset' ? PASSWORD_RESET_EXPIRY_MS : EMAIL_VERIFY_EXPIRY_MS));
  await db.query(
    `INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, $4)`,
    [userId, purpose, hash, expiresAt],
  );
  return raw;
}

async function recentTokenCount(userId, purpose) {
  const { rows } = await db.query(
    `SELECT COUNT(*) FROM email_tokens WHERE user_id = $1 AND purpose = $2 AND created_at >= now() - interval '1 hour'`,
    [userId, purpose],
  );
  return parseInt(rows[0].count, 10);
}

// Single-use, unexpired, hash-matched lookup shared by both confirm
// routes below - the only difference between password-reset/confirm and
// verify-email/confirm is what happens AFTER a token is found valid.
async function consumeEmailToken(rawToken, purpose) {
  if (typeof rawToken !== 'string' || !rawToken) return null;
  const hash = hashEmailToken(rawToken);
  const { rows } = await db.query(
    `UPDATE email_tokens SET used_at = now()
     WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [hash, purpose],
  );
  return rows[0]?.user_id || null;
}

router.post('/signup', asyncHandler(async (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (!isValidEmail(email) || typeof password !== 'string' || password.length < 10) {
    return res.status(400).json({ error: 'Valid email and a password of at least 10 characters are required' });
  }

  const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const passwordHash = await hashPassword(password);
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, display_name, last_login_at)
     VALUES ($1, $2, $3, now())
     RETURNING id, email, display_name, token_version, is_owner`,
    [email, passwordHash, displayName || null],
  );
  const user = rows[0];

  await logAuthEvent({ email, userId: user.id, success: true, ip: clientIp(req) });
  res.status(201).json({
    token: signUserToken(user),
    user: { id: user.id, email: user.email, displayName: user.display_name, isOwner: user.is_owner },
  });

  // Fire-and-forget, deliberately AFTER the response is already sent -
  // signup must return a usable token immediately regardless of whether
  // the email provider is slow or down (see the plan doc's "log in once
  // and be done" framing). A send failure here is logged, never surfaced
  // to the client as a signup failure.
  issueEmailToken(user.id, 'email_verify')
    .then(rawToken => sendVerificationEmail(email, verifyEmailLink(rawToken)))
    .catch(err => console.error('Failed to send verification email:', err));
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const ip = clientIp(req);

  if (!isValidEmail(email) || typeof password !== 'string') {
    await logAuthEvent({ email: email || '', success: false, ip });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const { rows } = await db.query('SELECT id, email, password_hash, display_name, status, token_version, is_owner FROM users WHERE email = $1', [email]);
  const user = rows[0];

  // Same 401/message whether the account doesn't exist, the password is
  // wrong, or the account is disabled - prevents user enumeration AND
  // avoids telegraphing "you're disabled" to whoever's holding a disabled
  // account's credentials. The reason a real disable happened lives in the
  // admin panel, not in this error.
  const passwordOk = user ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !passwordOk || user.status !== 'active') {
    await logAuthEvent({ email, userId: user ? user.id : null, success: false, ip });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (!user.is_owner && process.env.OWNER_EMAIL && user.email.toLowerCase() === process.env.OWNER_EMAIL.toLowerCase()) {
    await db.query('UPDATE users SET is_owner = true WHERE id = $1', [user.id]);
    user.is_owner = true;
  }
  const isOwner = Boolean(user.is_owner || (process.env.OWNER_EMAIL && user.email.toLowerCase() === process.env.OWNER_EMAIL.toLowerCase()));

  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await logAuthEvent({ email, userId: user.id, success: true, ip });
  res.json({
    token: signUserToken(user),
    user: { id: user.id, email: user.email, displayName: user.display_name, isOwner: isOwner },
  });
}));

router.delete('/account', requireUser, asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  const { rows } = await db.query('SELECT email, password_hash, is_owner FROM users WHERE id = $1', [req.user.id]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const isOwner = Boolean(user.is_owner || (process.env.OWNER_EMAIL && user.email.toLowerCase() === process.env.OWNER_EMAIL.toLowerCase()));
  if (isOwner) {
    return res.status(403).json({ error: 'Owner account cannot be deleted via self-service' });
  }

  const ok = typeof password === 'string' && await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(403).json({ error: 'Incorrect password' });

  // ON DELETE CASCADE on every table that references users.id (device_keys,
  // readings, shares as owner or viewer) - this one statement removes all
  // of it. See schema.sql.
  await db.query('DELETE FROM users WHERE id = $1', [req.user.id]);
  res.json({ deleted: true });
}));

// Always 200 with the same body regardless of whether the email matches a
// real account - the whole point is not telling a caller which emails
// have accounts (enumeration). The IP-based authLimiter already covers
// this route (see server.js); recentTokenCount adds a per-email ceiling
// on top so a rotating-IP attacker can't spam one inbox.
router.post('/password-reset/request', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  const responseBody = { message: 'If an account exists for that email, a reset link has been sent.' };
  if (!isValidEmail(email)) return res.json(responseBody);

  const { rows } = await db.query('SELECT id, status FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user || user.status !== 'active') return res.json(responseBody);

  if (await recentTokenCount(user.id, 'password_reset') >= MAX_PENDING_TOKENS_PER_HOUR) return res.json(responseBody);

  const rawToken = await issueEmailToken(user.id, 'password_reset');
  await sendPasswordResetEmail(email, resetPasswordLink(rawToken))
    .catch(err => console.error('Failed to send password-reset email:', err));

  res.json(responseBody);
}));

router.post('/password-reset/confirm', asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 10) {
    return res.status(400).json({ error: 'A new password of at least 10 characters is required' });
  }

  const userId = await consumeEmailToken(token, 'password_reset');
  if (!userId) return res.status(400).json({ error: 'That reset link is invalid or has expired' });

  const passwordHash = await hashPassword(newPassword);
  // token_version + 1 in the same statement as the password update - kills
  // every OTHER outstanding session for this account atomically with the
  // password change itself. We also revoke all device keys (uploaders and
  // viewers) so compromised or stale credentials cannot access or upload data.
  const userEmail = await db.transaction(async (tx) => {
    const { rows } = await tx(
      `UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING email`,
      [passwordHash, userId],
    );
    await tx(
      `UPDATE device_keys SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    return rows[0]?.email;
  });

  if (userEmail) {
    sendPasswordChangedEmail(userEmail)
      .catch(err => console.error('Failed to send password-changed email:', err));
  }

  res.json({ reset: true });
}));

router.post('/verify-email/resend', requireUser, asyncHandler(async (req, res) => {
  if (await recentTokenCount(req.user.id, 'email_verify') >= MAX_PENDING_TOKENS_PER_HOUR) {
    return res.status(429).json({ error: 'Too many verification emails sent recently - try again later' });
  }
  const rawToken = await issueEmailToken(req.user.id, 'email_verify');
  await sendVerificationEmail(req.user.email, verifyEmailLink(rawToken));
  res.json({ sent: true });
}));

router.post('/verify-email/confirm', asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  const userId = await consumeEmailToken(token, 'email_verify');
  if (!userId) return res.status(400).json({ error: 'That verification link is invalid or has expired' });

  await db.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [userId]);
  res.json({ verified: true });
}));

router.get('/me', requireUser, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, email, display_name, email_verified_at, created_at, last_login_at, is_owner, dob, diagnosis_date, target_low, target_high, units FROM users WHERE id = $1',
    [req.user.id],
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.is_owner && process.env.OWNER_EMAIL && user.email.toLowerCase() === process.env.OWNER_EMAIL.toLowerCase()) {
    await db.query('UPDATE users SET is_owner = true WHERE id = $1', [user.id]);
    user.is_owner = true;
  }
  const isOwner = Boolean(user.is_owner || (process.env.OWNER_EMAIL && user.email.toLowerCase() === process.env.OWNER_EMAIL.toLowerCase()));

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      emailVerified: !!user.email_verified_at,
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
      isOwner: isOwner,
      dob: user.dob || null,
      diagnosisDate: user.diagnosis_date || null,
      targetLow: user.target_low != null ? Number(user.target_low) : 70,
      targetHigh: user.target_high != null ? Number(user.target_high) : 180,
      units: user.units || 'mg/dL',
    },
  });
}));

router.patch('/profile', requireUser, asyncHandler(async (req, res) => {
  const { displayName, dob, diagnosisDate, targetLow, targetHigh, units } = req.body || {};

  const updates = [];
  const params = [req.user.id];

  if (displayName !== undefined) {
    const val = typeof displayName === 'string' ? displayName.trim() : null;
    params.push(val);
    updates.push(`display_name = $${params.length}`);
  }

  if (dob !== undefined) {
    const val = typeof dob === 'string' && dob.trim() ? dob.trim() : null;
    params.push(val);
    updates.push(`dob = $${params.length}`);
  }

  if (diagnosisDate !== undefined) {
    const val = typeof diagnosisDate === 'string' && diagnosisDate.trim() ? diagnosisDate.trim() : null;
    params.push(val);
    updates.push(`diagnosis_date = $${params.length}`);
  }

  if (targetLow !== undefined) {
    const num = parseInt(targetLow, 10);
    if (isNaN(num) || num < 40 || num > 150) {
      return res.status(400).json({ error: 'Target low must be between 40 and 150 mg/dL' });
    }
    params.push(num);
    updates.push(`target_low = $${params.length}`);
  }

  if (targetHigh !== undefined) {
    const num = parseInt(targetHigh, 10);
    if (isNaN(num) || num < 120 || num > 350) {
      return res.status(400).json({ error: 'Target high must be between 120 and 350 mg/dL' });
    }
    params.push(num);
    updates.push(`target_high = $${params.length}`);
  }

  if (units !== undefined) {
    if (units !== 'mg/dL' && units !== 'mmol/L') {
      return res.status(400).json({ error: "Units must be either 'mg/dL' or 'mmol/L'" });
    }
    params.push(units);
    updates.push(`units = $${params.length}`);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid profile fields provided for update' });
  }

  const { rows } = await db.query(
    `UPDATE users SET ${updates.join(', ')} WHERE id = $1 RETURNING id, email, display_name, email_verified_at, created_at, last_login_at, is_owner, dob, diagnosis_date, target_low, target_high, units`,
    params,
  );
  const updated = rows[0];
  if (!updated) return res.status(404).json({ error: 'User not found' });

  res.json({
    success: true,
    user: {
      id: updated.id,
      email: updated.email,
      displayName: updated.display_name,
      emailVerified: !!updated.email_verified_at,
      createdAt: updated.created_at,
      lastLoginAt: updated.last_login_at,
      isOwner: Boolean(updated.is_owner || (process.env.OWNER_EMAIL && updated.email.toLowerCase() === process.env.OWNER_EMAIL.toLowerCase())),
      dob: updated.dob || null,
      diagnosisDate: updated.diagnosis_date || null,
      targetLow: updated.target_low != null ? Number(updated.target_low) : 70,
      targetHigh: updated.target_high != null ? Number(updated.target_high) : 180,
      units: updated.units || 'mg/dL',
    },
  });
}));

router.post('/change-email', requireUser, asyncHandler(async (req, res) => {
  const { newEmail, currentPassword } = req.body || {};
  if (!isValidEmail(newEmail)) {
    return res.status(400).json({ error: 'A valid new email address is required' });
  }
  if (typeof currentPassword !== 'string' || !currentPassword) {
    return res.status(400).json({ error: 'Current password is required to change your email' });
  }

  const { rows: userRows } = await db.query(
    'SELECT id, email, password_hash, display_name, is_owner, dob, diagnosis_date, target_low, target_high, units FROM users WHERE id = $1',
    [req.user.id],
  );
  const user = userRows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const ok = await verifyPassword(currentPassword, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Incorrect password' });

  if (newEmail.trim().toLowerCase() === user.email.toLowerCase()) {
    return res.status(400).json({ error: 'New email is identical to current email' });
  }

  const { rows: existingRows } = await db.query(
    'SELECT id FROM users WHERE email = $1',
    [newEmail.trim()],
  );
  if (existingRows.length > 0) {
    return res.status(409).json({ error: 'An account with that email address already exists' });
  }

  const { rows: updatedRows } = await db.query(
    `UPDATE users SET email = $1, email_verified_at = NULL WHERE id = $2
     RETURNING id, email, display_name, token_version, is_owner, dob, diagnosis_date, target_low, target_high, units`,
    [newEmail.trim(), user.id],
  );
  const updatedUser = updatedRows[0];

  issueEmailToken(updatedUser.id, 'email_verify')
    .then(rawToken => sendVerificationEmail(updatedUser.email, verifyEmailLink(rawToken)))
    .catch(err => console.error('Failed to send email verification after email change:', err));

  res.json({
    success: true,
    token: signUserToken(updatedUser),
    user: {
      id: updatedUser.id,
      email: updatedUser.email,
      displayName: updatedUser.display_name,
      emailVerified: false,
      isOwner: updatedUser.is_owner,
      dob: updatedUser.dob || null,
      diagnosisDate: updatedUser.diagnosis_date || null,
      targetLow: updatedUser.target_low != null ? Number(updatedUser.target_low) : 70,
      targetHigh: updatedUser.target_high != null ? Number(updatedUser.target_high) : 180,
      units: updatedUser.units || 'mg/dL',
    },
  });
}));

async function isUserOwner(userId, userEmail) {
  const { rows } = await db.query('SELECT is_owner FROM users WHERE id = $1', [userId]);
  return Boolean(rows[0]?.is_owner || (process.env.OWNER_EMAIL && userEmail && userEmail.toLowerCase() === process.env.OWNER_EMAIL.toLowerCase()));
}

router.get('/system-health', requireUser, asyncHandler(async (req, res) => {
  const isOwner = await isUserOwner(req.user.id, req.user.email);
  if (!isOwner) return res.status(403).json({ error: 'Owner access required' });

  const { rows: userCountRows } = await db.query('SELECT COUNT(*)::int AS count FROM users');
  const { rows: readingCountRows } = await db.query('SELECT COUNT(*)::int AS count FROM readings');
  const { rows: deviceCountRows } = await db.query('SELECT COUNT(*)::int AS count FROM device_keys WHERE revoked_at IS NULL');

  res.json({
    status: 'healthy',
    uptimeSeconds: Math.floor(process.uptime()),
    database: 'connected',
    counts: {
      totalUsers: userCountRows[0]?.count || 0,
      totalReadings: readingCountRows[0]?.count || 0,
      activeDevices: deviceCountRows[0]?.count || 0,
    },
    nodeVersion: process.version,
    memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
}));

// --- Owner User Management Endpoints ---

router.get('/owner/users', requireUser, asyncHandler(async (req, res) => {
  const isOwner = await isUserOwner(req.user.id, req.user.email);
  if (!isOwner) return res.status(403).json({ error: 'Owner access required' });

  const search = (req.query.q || '').trim();
  const conditions = [];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(u.email ILIKE $${params.length} OR u.display_name ILIKE $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await db.query(
    `SELECT u.id, u.email, u.display_name, u.status, u.is_owner, u.email_verified_at, u.created_at, u.last_login_at,
            (SELECT COUNT(*)::int FROM device_keys dk WHERE dk.user_id = u.id AND dk.revoked_at IS NULL) AS active_devices,
            (SELECT COUNT(*)::int FROM shares s WHERE s.owner_id = u.id OR s.viewer_id = u.id) AS share_count
     FROM users u
     ${where}
     ORDER BY u.created_at ASC`,
    params,
  );

  res.json({
    users: rows.map(r => ({
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      status: r.status,
      isOwner: r.is_owner,
      emailVerified: r.email_verified_at !== null,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      activeDevices: r.active_devices || 0,
      shareCount: r.share_count || 0,
    })),
  });
}));

router.get('/owner/users/:id', requireUser, asyncHandler(async (req, res) => {
  const isOwner = await isUserOwner(req.user.id, req.user.email);
  if (!isOwner) return res.status(403).json({ error: 'Owner access required' });

  const { rows: userRows } = await db.query(
    `SELECT id, email, display_name, status, is_owner, email_verified_at, created_at, last_login_at
     FROM users WHERE id = $1`,
    [req.params.id],
  );
  if (userRows.length === 0) return res.status(404).json({ error: 'User not found' });
  const u = userRows[0];

  const { rows: devices } = await db.query(
    `SELECT id, label, key_prefix, role, created_at, last_used_at, revoked_at
     FROM device_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.params.id],
  );

  const { rows: shares } = await db.query(
    `SELECT s.id, s.owner_id, s.viewer_id, s.created_at, ou.email AS owner_email, vu.email AS viewer_email
     FROM shares s
     JOIN users ou ON s.owner_id = ou.id
     JOIN users vu ON s.viewer_id = vu.id
     WHERE s.owner_id = $1 OR s.viewer_id = $1
     ORDER BY s.created_at DESC`,
    [req.params.id],
  );

  res.json({
    user: {
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      status: u.status,
      isOwner: u.is_owner,
      emailVerified: u.email_verified_at !== null,
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
    },
    devices: devices.map(d => ({
      id: d.id,
      label: d.label,
      keyPrefix: d.key_prefix,
      role: d.role,
      createdAt: d.created_at,
      lastUsedAt: d.last_used_at,
      revoked: d.revoked_at !== null,
    })),
    shares: shares.map(s => ({
      id: s.id,
      ownerId: s.owner_id,
      viewerId: s.viewer_id,
      ownerEmail: s.owner_email,
      viewerEmail: s.viewer_email,
      createdAt: s.created_at,
    })),
  });
}));

router.post('/owner/users/:id/disable', requireUser, asyncHandler(async (req, res) => {
  const isOwner = await isUserOwner(req.user.id, req.user.email);
  if (!isOwner) return res.status(403).json({ error: 'Owner access required' });
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot disable your own owner account' });
  }

  const { rows } = await db.query(
    `UPDATE users SET status = 'disabled', disabled_at = now() WHERE id = $1 AND status = 'active' RETURNING id`,
    [req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'User not found or already disabled' });
  res.json({ success: true, disabled: true });
}));

router.post('/owner/users/:id/enable', requireUser, asyncHandler(async (req, res) => {
  const isOwner = await isUserOwner(req.user.id, req.user.email);
  if (!isOwner) return res.status(403).json({ error: 'Owner access required' });

  const { rows } = await db.query(
    `UPDATE users SET status = 'active', disabled_at = NULL WHERE id = $1 AND status = 'disabled' RETURNING id`,
    [req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'User not found or already active' });
  res.json({ success: true, enabled: true });
}));

router.delete('/owner/users/:id', requireUser, asyncHandler(async (req, res) => {
  const isOwner = await isUserOwner(req.user.id, req.user.email);
  if (!isOwner) return res.status(403).json({ error: 'Owner access required' });
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own owner account' });
  }

  const { rows: targetRows } = await db.query('SELECT id, email, is_owner FROM users WHERE id = $1', [req.params.id]);
  if (targetRows.length === 0) return res.status(404).json({ error: 'User not found' });
  if (targetRows[0].is_owner) {
    return res.status(403).json({ error: 'Cannot delete an account designated as owner' });
  }

  // Database foreign keys have ON DELETE CASCADE for related records
  await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ success: true, deleted: true, email: targetRows[0].email });
}));

router.post('/owner/devices/:id/revoke', requireUser, asyncHandler(async (req, res) => {
  const isOwner = await isUserOwner(req.user.id, req.user.email);
  if (!isOwner) return res.status(403).json({ error: 'Owner access required' });

  const { rows } = await db.query(
    `UPDATE device_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id, user_id`,
    [req.params.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Device key not found or already revoked' });
  res.json({ success: true, revoked: true });
}));

router.post('/change-password', requireUser, asyncHandler(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 10) {
    return res.status(400).json({ error: 'New password of at least 10 characters is required' });
  }

  const { rows: userRows } = await db.query(
    'SELECT id, email, password_hash, display_name, is_owner FROM users WHERE id = $1',
    [req.user.id],
  );
  const user = userRows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const ok = await verifyPassword(oldPassword, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Incorrect current password' });

  const passwordHash = await hashPassword(newPassword);
  const updatedUser = await db.transaction(async (tx) => {
    const { rows } = await tx(
      `UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2
       RETURNING id, email, display_name, token_version, is_owner`,
      [passwordHash, user.id],
    );
    await tx(
      `UPDATE device_keys SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id],
    );
    return rows[0];
  });

  if (updatedUser?.email) {
    sendPasswordChangedEmail(updatedUser.email)
      .catch(err => console.error('Failed to send password-changed email:', err));
  }

  res.json({
    success: true,
    token: signUserToken(updatedUser),
    user: {
      id: updatedUser.id,
      email: updatedUser.email,
      displayName: updatedUser.display_name,
      isOwner: updatedUser.is_owner,
    },
  });
}));

module.exports = router;
