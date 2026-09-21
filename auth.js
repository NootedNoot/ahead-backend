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

// tokenVersion (2026-08-27, password reset) is embedded so requireUser can
// invalidate every OTHER outstanding session at once by bumping the DB
// column - the same trick `status` already uses for instant disable, now
// available for "I just reset my password, kill my old sessions too"
// without a token blacklist table. Callers MUST pass the user row's
// current token_version - defaulting it here would silently mint tokens
// that never actually check anything.
function signUserToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, tokenVersion: user.token_version },
    requireEnv('JWT_SECRET'),
    { expiresIn: USER_TOKEN_EXPIRY },
  );
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

  const { rows } = await db.query('SELECT id, email, status, token_version FROM users WHERE id = $1', [payload.sub]);
  const user = rows[0];
  if (!user || user.status !== 'active') return res.status(401).json({ error: 'Account not found or disabled' });
  // A password reset bumps token_version - any token signed before that
  // reset (payload.tokenVersion is now stale) is rejected here even though
  // its signature and expiry are both still perfectly valid. Tokens signed
  // before this column existed carry no tokenVersion claim at all
  // (undefined, not 0 - those are NOT the same value in JS), so this
  // normalizes a missing claim to 0 to match the column's own default -
  // otherwise every currently-logged-in session gets force-logged-out the
  // moment this deploys, not just after a real reset.
  const tokenVersion = payload.tokenVersion ?? 0;
  if (tokenVersion !== user.token_version) return res.status(401).json({ error: 'Invalid or expired token' });

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

// Uploader lookup. Accepts ONLY role='uploader' rows: a viewer key (read-only,
// see below) shares this table and this hash scheme, so without the role
// filter a viewer key's hash would authenticate as a full uploader.
//
// Deploy-order safety net: if this code is ever live BEFORE
// migrations/2026-09-20_viewer_keys.sql has been run, the role column does
// not exist yet and the role-filtered query would fail (Postgres 42703) - taking
// every phone's upload down. In that one situation no viewer key can exist
// either (minting needs the column too), so falling back to the original,
// role-less query is exactly as safe as before and keeps uploads alive.
// It logs loudly so the missing migration gets noticed.
async function findUploaderKey(keyHash) {
  try {
    const { rows } = await db.query(
      `SELECT dk.id, dk.user_id, u.status
       FROM device_keys dk
       JOIN users u ON u.id = dk.user_id
       WHERE dk.key_hash = $1 AND dk.revoked_at IS NULL AND dk.role = 'uploader'`,
      [keyHash],
    );
    return rows[0];
  } catch (err) {
    if (err && err.code === '42703' && /\brole\b/.test(err.message || '')) {
      console.error('device_keys.role column is missing - run migrations/2026-09-20_viewer_keys.sql. Falling back to role-less uploader lookup.');
      const { rows } = await db.query(
        `SELECT dk.id, dk.user_id, u.status
         FROM device_keys dk
         JOIN users u ON u.id = dk.user_id
         WHERE dk.key_hash = $1 AND dk.revoked_at IS NULL`,
        [keyHash],
      );
      return rows[0];
    }
    throw err;
  }
}

// X-Ahead-Api-Key -> req.userId. Also updates last_used_at so the admin
// panel's device list is meaningful, not just a mint timestamp.
const requireDeviceKey = asyncHandler(async function requireDeviceKey(req, res, next) {
  const rawKey = req.get('X-Ahead-Api-Key');
  if (!rawKey) return res.status(401).json({ error: 'Missing X-Ahead-Api-Key header' });

  const keyHash = hashDeviceKey(rawKey);
  const device = await findUploaderKey(keyHash);
  if (!device || device.status !== 'active') return res.status(401).json({ error: 'Unknown, revoked, or disabled device key' });

  await db.query('UPDATE device_keys SET last_used_at = now() WHERE id = $1', [device.id]);
  req.userId = device.user_id;
  next();
});

// --- Viewer keys (read-only, for the caregiver app) -------------------
// Same storage, hashing (HMAC-SHA256 + DEVICE_KEY_PEPPER) and key_prefix
// approach as device keys, in the same table with role='viewer'. Its own raw
// prefix ("ahead_vk_") makes a leaked key recognisable as read-only.
//
// A viewer key is accepted by exactly ONE middleware, requireUserOrViewerKey
// below, which server routes attach to exactly two GET routes
// (GET /api/readings, GET /api/shares/accessible). It is refused by
// requireDeviceKey (role filter above) and is not looked at by requireUser,
// requireAdmin or anything else, so it cannot upload, delete, mint keys,
// touch shares/devices/account, or reach admin.
const VIEWER_KEY_PREFIX = 'ahead_vk_';

function generateViewerKey() {
  const raw = VIEWER_KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashDeviceKey(raw), prefix: raw.slice(0, 12) };
}

// X-Ahead-Viewer-Key -> req.user = {id, email} of the key's owner, exactly
// what requireUser would have set. Authorization AFTER authentication is the
// route's own and is unchanged (e.g. reading another user's stream still
// needs a `shares` row). With no X-Ahead-Viewer-Key header this is
// requireUser verbatim, so the JWT keeps working on these routes. If the
// header IS present it is the only credential considered: a bad viewer key
// is a 401, it never falls through to a Bearer token.
const requireUserOrViewerKey = asyncHandler(async function requireUserOrViewerKey(req, res, next) {
  const rawKey = req.get('X-Ahead-Viewer-Key');
  if (!rawKey) return requireUser(req, res, next);

  const { rows } = await db.query(
    `SELECT dk.id, u.id AS user_id, u.email, u.status
     FROM device_keys dk
     JOIN users u ON u.id = dk.user_id
     WHERE dk.key_hash = $1 AND dk.role = 'viewer' AND dk.revoked_at IS NULL`,
    [hashDeviceKey(rawKey)],
  );
  const viewer = rows[0];
  if (!viewer || viewer.status !== 'active') return res.status(401).json({ error: 'Unknown, revoked, or disabled viewer key' });

  await db.query('UPDATE device_keys SET last_used_at = now() WHERE id = $1', [viewer.id]);
  req.user = { id: viewer.user_id, email: viewer.email };
  next();
});

// --- Password-reset / email-verify tokens -----------------------------
// Same shape as device keys above (256 random bits, base64url, prefixed,
// hashed at rest) but with its own pepper (EMAIL_TOKEN_PEPPER) - every
// secret in this app is scoped to exactly one concern, never reused across
// unrelated credential types, so a leak of one pepper can't be replayed
// against a different kind of token.
const EMAIL_TOKEN_PREFIX = 'ahead_et_';

function generateEmailToken() {
  const raw = EMAIL_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashEmailToken(raw) };
}

function hashEmailToken(rawToken) {
  return crypto.createHmac('sha256', requireEnv('EMAIL_TOKEN_PEPPER')).update(rawToken).digest('hex');
}

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
  requireUserOrViewerKey,
  generateDeviceKey,
  generateViewerKey,
  generateEmailToken,
  hashEmailToken,
  logAuthEvent,
  clientIp,
  verifyInviteSecret,
};
