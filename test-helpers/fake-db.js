// In-memory stand-in for the Postgres layer, used ONLY by the tests.
//
// The tests must never touch a real database (and above all never the
// production one), so the harness replaces `db.query` / `db.transaction`
// with this. It is deliberately dumb: it recognises the exact SQL the app
// runs (matched on whitespace-normalised text) and applies the same
// semantics in plain JS. Any SQL it does NOT recognise throws, so a route
// that starts running an unexpected query fails a test loudly instead of
// silently getting an empty result.
//
// It lives outside test/ on purpose: Node's test runner executes every .js
// file under a directory named "test", and this is a helper, not a test.
const crypto = require('crypto');

const norm = sql => sql.replace(/\s+/g, ' ').trim();

class FakeDb {
  constructor() {
    this.users = [];
    this.deviceKeys = [];
    this.shares = [];
    this.readings = [];
    this.emailTokens = [];
    this.authEvents = [];
    this.log = [];              // every normalised SQL string that ran
    this.missingRoleColumn = false;  // simulate "migration not run yet"
    this.failOn = null;         // (sql) => boolean; makes a matching query throw
    this.handlers = buildHandlers();
  }

  async query(text, params = []) {
    const sql = norm(text);
    this.log.push(sql);
    if (this.failOn && this.failOn(sql)) throw new Error('FakeDb: injected failure');
    if (this.missingRoleColumn && /\brole\b/.test(sql)) {
      const err = new Error('column "role" does not exist');
      err.code = '42703';
      throw err;
    }
    for (const [pattern, fn] of this.handlers) {
      if (pattern.test(sql)) return fn(this, params, sql);
    }
    throw new Error(`FakeDb: unhandled SQL: ${sql}`);
  }

  // Mirrors db.transaction(): run fn with a query function; if fn throws,
  // every change it made is rolled back (snapshot restore).
  async transaction(fn) {
    const snapshot = this._snapshot();
    try {
      return await fn((text, params) => this.query(text, params));
    } catch (err) {
      this._restore(snapshot);
      throw err;
    }
  }

  _snapshot() {
    const copy = arr => arr.map(row => ({ ...row }));
    return {
      users: copy(this.users), deviceKeys: copy(this.deviceKeys), shares: copy(this.shares),
      readings: copy(this.readings), emailTokens: copy(this.emailTokens),
    };
  }

  _restore(s) {
    this.users = s.users; this.deviceKeys = s.deviceKeys; this.shares = s.shares;
    this.readings = s.readings; this.emailTokens = s.emailTokens;
  }

  // ---- seeding helpers ----
  addUser({ email, status = 'active', tokenVersion = 0, verified = true } = {}) {
    const user = {
      id: crypto.randomUUID(),
      email,
      password_hash: 'x',
      display_name: null,
      status,
      token_version: tokenVersion,
      is_owner: false,
      email_verified_at: verified ? new Date() : null,
    };
    this.users.push(user);
    return user;
  }

  addDeviceKeyRow({ userId, hash, prefix = 'ahead_xx_abc', label = null, role = 'uploader', revoked = false }) {
    const row = {
      id: crypto.randomUUID(), user_id: userId, key_hash: hash, key_prefix: prefix, label, role,
      created_at: new Date(), last_used_at: null, revoked_at: revoked ? new Date() : null,
    };
    this.deviceKeys.push(row);
    return row;
  }

  addShare(ownerId, viewerId) {
    this.shares.push({ id: crypto.randomUUID(), owner_id: ownerId, viewer_id: viewerId, created_at: new Date() });
  }

  addReading(userId, timeMs, sgv) {
    this.readings.push({ user_id: userId, reading_time_ms: timeMs, sgv });
  }
}

function buildHandlers() {
  const h = [];
  const on = (pattern, fn) => h.push([pattern, fn]);
  const rowsOf = rows => ({ rows, rowCount: rows.length });

  // ---- users ----
  on(/^SELECT id, email, status, token_version FROM users WHERE id = \$1$/, (db, [id]) =>
    rowsOf(db.users.filter(u => u.id === id).map(u => ({ id: u.id, email: u.email, status: u.status, token_version: u.token_version }))));

  on(/^SELECT id, status FROM users WHERE email = \$1$/, (db, [email]) =>
    rowsOf(db.users.filter(u => u.email.toLowerCase() === String(email).toLowerCase()).map(u => ({ id: u.id, status: u.status }))));

  on(/^SELECT id FROM users WHERE email = \$1$/, (db, [email]) =>
    rowsOf(db.users.filter(u => u.email.toLowerCase() === String(email).toLowerCase()).map(u => ({ id: u.id }))));

  on(/^INSERT INTO users \(email, password_hash, display_name, last_login_at\)/, (db, [email, hash, displayName]) => {
    const user = db.addUser({ email, verified: false });
    user.password_hash = hash;
    user.display_name = displayName;
    return rowsOf([{ id: user.id, email: user.email, display_name: user.display_name, token_version: user.token_version, is_owner: user.is_owner }]);
  });

  on(/^INSERT INTO auth_events /, (db, params) => { db.authEvents.push(params); return rowsOf([]); });

  on(/^UPDATE users SET email_verified_at = now\(\) WHERE id = \$1$/, (db, [id]) => {
    const u = db.users.find(x => x.id === id);
    if (u) u.email_verified_at = new Date();
    return rowsOf([]);
  });

  // ---- email_tokens ----
  on(/^INSERT INTO email_tokens \(user_id, purpose, token_hash, expires_at\) VALUES \(\$1, \$2, \$3, \$4\)$/, (db, [userId, purpose, hash, expiresAt]) => {
    db.emailTokens.push({ user_id: userId, purpose, token_hash: hash, expires_at: expiresAt, used_at: null, created_at: new Date() });
    return rowsOf([]);
  });

  on(/^SELECT COUNT\(\*\) FROM email_tokens WHERE user_id = \$1 AND purpose = \$2 AND created_at >= now\(\) - interval '1 hour'$/, (db, [userId, purpose]) => {
    const cutoff = Date.now() - 3600_000;
    const n = db.emailTokens.filter(t => t.user_id === userId && t.purpose === purpose && t.created_at.getTime() >= cutoff).length;
    return rowsOf([{ count: String(n) }]);
  });

  on(/^UPDATE email_tokens SET used_at = now\(\) WHERE token_hash = \$1 AND purpose = \$2 AND used_at IS NULL AND expires_at > now\(\) RETURNING user_id$/, (db, [hash, purpose]) => {
    const t = db.emailTokens.find(x => x.token_hash === hash && x.purpose === purpose && !x.used_at && new Date(x.expires_at) > new Date());
    if (!t) return rowsOf([]);
    t.used_at = new Date();
    return rowsOf([{ user_id: t.user_id }]);
  });

  // ---- device_keys / viewer keys ----
  // requireDeviceKey: honours the role filter exactly as written in the SQL.
  on(/^SELECT dk\.id, dk\.user_id, u\.status FROM device_keys dk JOIN users u ON u\.id = dk\.user_id WHERE dk\.key_hash = \$1 AND dk\.revoked_at IS NULL( AND dk\.role = '(uploader|viewer)')?$/, (db, [hash], sql) => {
    const roleMatch = sql.match(/AND dk\.role = '(uploader|viewer)'/);
    const found = db.deviceKeys.filter(k => k.key_hash === hash && !k.revoked_at && (!roleMatch || k.role === roleMatch[1]));
    return rowsOf(found.map(k => ({ id: k.id, user_id: k.user_id, status: db.users.find(u => u.id === k.user_id)?.status })));
  });

  // requireUserOrViewerKey lookup (also returns the owner's email).
  on(/^SELECT dk\.id, u\.id AS user_id, u\.email, u\.status FROM device_keys dk JOIN users u ON u\.id = dk\.user_id WHERE dk\.key_hash = \$1 AND dk\.role = 'viewer' AND dk\.revoked_at IS NULL$/, (db, [hash]) => {
    const found = db.deviceKeys.filter(k => k.key_hash === hash && k.role === 'viewer' && !k.revoked_at);
    return rowsOf(found.map(k => {
      const u = db.users.find(x => x.id === k.user_id);
      return { id: k.id, user_id: u.id, email: u.email, status: u.status };
    }));
  });

  on(/^UPDATE device_keys SET last_used_at = now\(\) WHERE id = \$1$/, (db, [id]) => {
    const k = db.deviceKeys.find(x => x.id === id);
    if (k) k.last_used_at = new Date();
    return rowsOf([]);
  });

  // ---- shares / readings ----
  on(/^SELECT 1 FROM shares WHERE owner_id = \$1 AND viewer_id = \$2$/, (db, [owner, viewer]) =>
    rowsOf(db.shares.filter(s => s.owner_id === owner && s.viewer_id === viewer).map(() => ({ '?column?': 1 }))));

  on(/^SELECT sgv, reading_time_ms FROM readings WHERE user_id = \$1 ORDER BY reading_time_ms DESC LIMIT \$2$/, (db, [userId, limit]) =>
    rowsOf(db.readings.filter(r => r.user_id === userId).sort((a, b) => b.reading_time_ms - a.reading_time_ms).slice(0, limit)
      .map(r => ({ sgv: r.sgv, reading_time_ms: String(r.reading_time_ms) }))));

  on(/^DELETE FROM readings WHERE user_id = \$1( AND reading_time_ms >= \$2)?$/, (db, [userId, since], sql) => {
    const before = db.readings.length;
    db.readings = db.readings.filter(r => !(r.user_id === userId && (!sql.includes('reading_time_ms >=') || r.reading_time_ms >= since)));
    return { rows: [], rowCount: before - db.readings.length };
  });

  on(/^SELECT u\.id AS owner_id, u\.email AS owner_email FROM shares s JOIN users u ON u\.id = s\.owner_id WHERE s\.viewer_id = \$1 ORDER BY u\.email$/, (db, [viewerId]) =>
    rowsOf(db.shares.filter(s => s.viewer_id === viewerId)
      .map(s => { const u = db.users.find(x => x.id === s.owner_id); return { owner_id: u.id, owner_email: u.email }; })));

  return h;
}

module.exports = { FakeDb, norm };
