// Core auth primitives shared by every route file: password hashing, JWT
// issue/verify for both the regular-user and admin auth surfaces (two
// separate secrets, two separate tables, never interchangeable - see
// schema.sql's comment on `admins`), device-API-key generation/hashing, and
// the auth-event logging every login/signup attempt writes regardless of
// outcome.
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./db');
const asyncHandler = require('./lib/asyncHandler');

const BCRYPT_COST = 12;
const USER_TOKEN_EXPIRY = '30d';

function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signUserToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, requireEnv('JWT_SECRET'), { expiresIn: USER_TOKEN_EXPIRY });
}

function signAdminToken(admin) {
  return jwt.sign({ sub: admin.id, email: admin.email, role: 'admin' }, requireEnv('ADMIN_JWT_SECRET'), { expiresIn: USER_TOKEN_EXPIRY });
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

// Real client IP behind Railway's proxy - server.js sets `app.set('trust
// proxy', true)` so req.ip already resolves X-Forwarded-For correctly;
// this just centralizes the read so every call site agrees on the source.
function clientIp(req) {
  return req.ip || null;
}

// Every login/signup ATTEMPT, success or failure, writes here BEFORE the
// response goes out - not best-effort, not fire-and-forget. This is what
// the admin panel's failed-login log and "flags" computation both read.
async function logAuthEvent({ email, userId = null, isAdminAttempt = false, success, ip }) {
  await db.query(
    `INSERT INTO auth_events (email_attempted, user_id, is_admin_attempt, success, ip_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [email, userId, isAdminAttempt, success, ip],
  );
}

// Bearer JWT -> req.user = {id, email}. Re-validates against the DB on
// every call (not just the JWT signature) so account deletion AND admin
// "disable user" both take effect on the very next request, with no
// blacklist table - see schema.sql's comment on users.status.
const requireUser = asyncHandler(async function requireUser(req, res, next) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Missing or malformed Authorization header' });

  let payload;
  try {
    payload = jwt.verify(token, requireEnv('JWT_SECRET'), { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { rows } = await db.query('SELECT id, email, status FROM users WHERE id = $1', [payload.sub]);
  const user = rows[0];
  if (!user || user.status !== 'active') return res.status(401).json({ error: 'Account not found or disabled' });

  req.user = { id: user.id, email: user.email };
  next();
});

// Same pattern as requireUser, against the admins table with the admin-only
// secret - see the class doc for why these are never interchangeable.
const requireAdmin = asyncHandler(async function requireAdmin(req, res, next) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Missing or malformed Authorization header' });

  let payload;
  try {
    payload = jwt.verify(token, requireEnv('ADMIN_JWT_SECRET'), { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { rows } = await db.query('SELECT id, email FROM admins WHERE id = $1', [payload.sub]);
  const admin = rows[0];
  if (!admin) return res.status(401).json({ error: 'Admin account not found' });

  req.admin = { id: admin.id, email: admin.email };
  next();
});

function bearerToken(req) {
  const header = req.get('Authorization') || '';
  const match = header.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}

// --- Device API keys -------------------------------------------------
// Format: 256 random bits, base64url, prefixed so it's self-identifying in
// logs and never confusable with a JWT (which always starts "eyJ"). Server
// stores only HMAC-SHA256(rawKey, DEVICE_KEY_PEPPER) - a fast keyed hash,
// not bcrypt: a random 256-bit key has no guessable structure for bcrypt's
// slowness to defend against, so bcrypt would only add CPU cost to every
// 5-minute background upload for zero real security benefit. The pepper
// (separate env var) means a raw DB leak of key_hash alone still isn't
// directly usable without it.
const DEVICE_KEY_PREFIX = 'ahead_dk_';

function generateDeviceKey() {
  const raw = DEVICE_KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashDeviceKey(raw), prefix: raw.slice(0, 12) };
}

function hashDeviceKey(rawKey) {
  return crypto.createHmac('sha256', requireEnv('DEVICE_KEY_PEPPER')).update(rawKey).digest('hex');
}

// X-Ahead-Api-Key -> req.userId. Also updates last_used_at so the admin
// panel's device list is meaningful, not just a mint timestamp.
const requireDeviceKey = asyncHandler(async function requireDeviceKey(req, res, next) {
  const rawKey = req.get('X-Ahead-Api-Key');
  if (!rawKey) return res.status(401).json({ error: 'Missing X-Ahead-Api-Key header' });

  const keyHash = hashDeviceKey(rawKey);
  const { rows } = await db.query(
    `SELECT dk.id, dk.user_id, u.status
     FROM device_keys dk
     JOIN users u ON u.id = dk.user_id
     WHERE dk.key_hash = $1 AND dk.revoked_at IS NULL`,
    [keyHash],
  );
  const device = rows[0];
  if (!device || device.status !== 'active') return res.status(401).json({ error: 'Unknown, revoked, or disabled device key' });

  await db.query('UPDATE device_keys SET last_used_at = now() WHERE id = $1', [device.id]);
  req.userId = device.user_id;
  next();
});

// Constant-time comparison against ADMIN_INVITE_SECRET - a value that only
// ever lives in Railway's env vars, never in code, never sent to anyone
// except whoever the owner chooses to hand it to directly. This is the
// second, out-of-band factor for creating a new admin (see routes/admin.js
// POST /admins): a leaked admin JWT and even a leaked admin password alone
// still aren't enough to mint a new admin without also knowing this. Plain
// string equality would leak timing information about how many leading
// characters matched; timingSafeEqual avoids that even though the practical
// risk here is small.
function verifyInviteSecret(provided) {
  const expected = requireEnv('ADMIN_INVITE_SECRET');
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  hashPassword,
  verifyPassword,
  signUserToken,
  signAdminToken,
  requireUser,
  requireAdmin,
  requireDeviceKey,
  generateDeviceKey,
  logAuthEvent,
  clientIp,
  verifyInviteSecret,
};
