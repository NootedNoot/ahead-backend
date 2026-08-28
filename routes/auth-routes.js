const express = require('express');
const db = require('../db');
const {
  hashPassword, verifyPassword, signUserToken, requireUser, logAuthEvent, clientIp,
  generateEmailToken, hashEmailToken,
} = require('../auth');
const asyncHandler = require('../lib/asyncHandler');
const { isValidEmail } = require('../lib/validators');
const { sendPasswordResetEmail, sendVerificationEmail } = require('../lib/email');

const router = express.Router();

// Railway sets this to the service's own public hostname (no protocol) -
// falls back to localhost for anyone running this outside Railway. Every
// emailed link is built from this, never hardcoded, so a custom domain
// later is a zero-code-change env var swap.
const PUBLIC_BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'http://localhost:3000';

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
     RETURNING id, email, display_name, token_version`,
    [email, passwordHash, displayName || null],
  );
  const user = rows[0];

  await logAuthEvent({ email, userId: user.id, success: true, ip: clientIp(req) });
  res.status(201).json({ token: signUserToken(user), user: { id: user.id, email: user.email, displayName: user.display_name } });

  // Fire-and-forget, deliberately AFTER the response is already sent -
  // signup must return a usable token immediately regardless of whether
  // the email provider is slow or down (see the plan doc's "log in once
  // and be done" framing). A send failure here is logged, never surfaced
  // to the client as a signup failure.
  issueEmailToken(user.id, 'email_verify')
    .then(rawToken => sendVerificationEmail(email, `${PUBLIC_BASE_URL}/verify-email.html?token=${rawToken}`))
    .catch(err => console.error('Failed to send verification email:', err));
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const ip = clientIp(req);

  if (!isValidEmail(email) || typeof password !== 'string') {
    await logAuthEvent({ email: email || '', success: false, ip });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const { rows } = await db.query('SELECT id, email, password_hash, display_name, status, token_version FROM users WHERE email = $1', [email]);
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

  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await logAuthEvent({ email, userId: user.id, success: true, ip });
  res.json({ token: signUserToken(user), user: { id: user.id, email: user.email, displayName: user.display_name } });
}));

router.delete('/account', requireUser, asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  const ok = rows[0] && typeof password === 'string' && await verifyPassword(password, rows[0].password_hash);
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
  await sendPasswordResetEmail(email, `${PUBLIC_BASE_URL}/reset-password.html?token=${rawToken}`)
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
  // password change itself, not as a separate step that could be skipped
  // by a crash in between.
  await db.query(
    `UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2`,
    [passwordHash, userId],
  );
  res.json({ reset: true });
}));

router.post('/verify-email/resend', requireUser, asyncHandler(async (req, res) => {
  if (await recentTokenCount(req.user.id, 'email_verify') >= MAX_PENDING_TOKENS_PER_HOUR) {
    return res.status(429).json({ error: 'Too many verification emails sent recently - try again later' });
  }
  const rawToken = await issueEmailToken(req.user.id, 'email_verify');
  await sendVerificationEmail(req.user.email, `${PUBLIC_BASE_URL}/verify-email.html?token=${rawToken}`);
  res.json({ sent: true });
}));

router.post('/verify-email/confirm', asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  const userId = await consumeEmailToken(token, 'email_verify');
  if (!userId) return res.status(400).json({ error: 'That verification link is invalid or has expired' });

  await db.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [userId]);
  res.json({ verified: true });
}));

module.exports = router;
