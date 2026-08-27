const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, signUserToken, requireUser, logAuthEvent, clientIp } = require('../auth');
const asyncHandler = require('../lib/asyncHandler');
const { isValidEmail } = require('../lib/validators');

const router = express.Router();

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
     RETURNING id, email, display_name`,
    [email, passwordHash, displayName || null],
  );
  const user = rows[0];

  await logAuthEvent({ email, userId: user.id, success: true, ip: clientIp(req) });
  res.status(201).json({ token: signUserToken(user), user: { id: user.id, email: user.email, displayName: user.display_name } });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  const ip = clientIp(req);

  if (!isValidEmail(email) || typeof password !== 'string') {
    await logAuthEvent({ email: email || '', success: false, ip });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const { rows } = await db.query('SELECT id, email, password_hash, display_name, status FROM users WHERE email = $1', [email]);
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

module.exports = router;
