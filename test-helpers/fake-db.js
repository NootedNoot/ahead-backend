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

  on(/^UPDATE users SET is_owner = true WHERE id = \$1$/, (db, [id]) => {
    const u = db.users.find(x => x.id === id);
    if (u) u.is_owner = true;
    return rowsOf([]);
  });

  on(/^SELECT is_owner FROM users WHERE id = \$1$/, (db, [id]) =>
    rowsOf(db.users.filter(u => u.id === id).map(u => ({ is_owner: u.is_owner }))));

  on(/^SELECT COUNT\(\*\)::int AS count FROM users$/, (db) =>
    rowsOf([{ count: db.users.length }]));

  on(/^SELECT COUNT\(\*\)::int AS count FROM readings$/, (db) =>
    rowsOf([{ count: db.readings.length }]));

  on(/^SELECT COUNT\(\*\)::int AS count FROM device_keys WHERE revoked_at IS NULL$/, (db) =>
    rowsOf([{ count: db.deviceKeys.filter(k => !k.revoked_at).length }]));

  on(/^SELECT id, email, display_name, email_verified_at, created_at, last_login_at, is_owner(?:, dob, diagnosis_date, target_low, target_high, units)? FROM users WHERE id = \$1$/, (db, [id]) =>
    rowsOf(db.users.filter(u => u.id === id).map(u => ({
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      email_verified_at: u.email_verified_at,
      created_at: u.created_at || new Date(),
      last_login_at: u.last_login_at || new Date(),
      is_owner: u.is_owner,
      dob: u.dob || null,
      diagnosis_date: u.diagnosis_date || null,
      target_low: u.target_low != null ? u.target_low : 70,
      target_high: u.target_high != null ? u.target_high : 180,
      units: u.units || 'mg/dL',
    }))));

  on(/^SELECT id, email, password_hash, display_name, is_owner(?:, dob, diagnosis_date, target_low, target_high, units)? FROM users WHERE id = \$1$/, (db, [id]) =>
    rowsOf(db.users.filter(u => u.id === id).map(u => ({
      id: u.id,
      email: u.email,
      password_hash: u.password_hash,
      display_name: u.display_name,
      is_owner: u.is_owner,
      dob: u.dob || null,
      diagnosis_date: u.diagnosis_date || null,
      target_low: u.target_low != null ? u.target_low : 70,
      target_high: u.target_high != null ? u.target_high : 180,
      units: u.units || 'mg/dL',
    }))));

  on(/^SELECT email, password_hash, is_owner FROM users WHERE id = \$1$/, (db, [id]) =>
    rowsOf(db.users.filter(u => u.id === id).map(u => ({
      email: u.email,
      password_hash: u.password_hash,
      is_owner: u.is_owner,
    }))));

  on(/^SELECT id, email, is_owner FROM users WHERE id = \$1$/, (db, [id]) =>
    rowsOf(db.users.filter(u => u.id === id).map(u => ({
      id: u.id,
      email: u.email,
      is_owner: u.is_owner,
    }))));

  on(/^SELECT id, email, display_name, status, is_owner, email_verified_at, created_at, last_login_at FROM users WHERE id = \$1$/, (db, [id]) =>
    rowsOf(db.users.filter(u => u.id === id).map(u => ({
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      status: u.status,
      is_owner: u.is_owner,
      email_verified_at: u.email_verified_at,
      created_at: u.created_at || new Date(),
      last_login_at: u.last_login_at || new Date(),
    }))));

  on(/^SELECT u\.id, u\.email, u\.display_name, u\.status, u\.is_owner, u\.email_verified_at, u\.created_at, u\.last_login_at, \(SELECT COUNT\(\*\)::int FROM device_keys dk WHERE dk\.user_id = u\.id AND dk\.revoked_at IS NULL\) AS active_devices, \(SELECT COUNT\(\*\)::int FROM shares s WHERE s\.owner_id = u\.id OR s\.viewer_id = u\.id\) AS share_count FROM users u(?: WHERE \(u\.email ILIKE \$1 OR u\.display_name ILIKE \$1\))? ORDER BY u\.created_at ASC$/, (db, params, sql) => {
    let list = db.users;
    if (sql.includes('WHERE (u.email ILIKE')) {
      const q = String(params[0] || '').replace(/%/g, '').toLowerCase();
      list = list.filter(u => u.email.toLowerCase().includes(q) || (u.display_name && u.display_name.toLowerCase().includes(q)));
    }
    return rowsOf(list.map(u => ({
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      status: u.status,
      is_owner: u.is_owner,
      email_verified_at: u.email_verified_at,
      created_at: u.created_at || new Date(),
      last_login_at: u.last_login_at || new Date(),
      active_devices: db.deviceKeys.filter(k => k.user_id === u.id && !k.revoked_at).length,
      share_count: db.shares.filter(s => s.owner_id === u.id || s.viewer_id === u.id).length,
    })));
  });

  on(/^UPDATE users SET status = 'disabled', disabled_at = now\(\) WHERE id = \$1 AND status = 'active' RETURNING id$/, (db, [id]) => {
    const u = db.users.find(x => x.id === id && x.status === 'active');
    if (!u) return rowsOf([]);
    u.status = 'disabled';
    u.disabled_at = new Date();
    return rowsOf([{ id: u.id }]);
  });

  on(/^UPDATE users SET status = 'active', disabled_at = NULL WHERE id = \$1 AND status = 'disabled' RETURNING id$/, (db, [id]) => {
    const u = db.users.find(x => x.id === id && x.status === 'disabled');
    if (!u) return rowsOf([]);
    u.status = 'active';
    u.disabled_at = null;
    return rowsOf([{ id: u.id }]);
  });

  on(/^DELETE FROM users WHERE id = \$1(?: RETURNING id)?$/, (db, [id]) => {
    const idx = db.users.findIndex(x => x.id === id);
    if (idx === -1) return rowsOf([]);
    const [deleted] = db.users.splice(idx, 1);
    // Cascade
    db.deviceKeys = db.deviceKeys.filter(k => k.user_id !== id);
    db.shares = db.shares.filter(s => s.owner_id !== id && s.viewer_id !== id);
    db.readings = db.readings.filter(r => r.user_id !== id);
    db.emailTokens = db.emailTokens.filter(t => t.user_id !== id);
    return rowsOf([{ id: deleted.id }]);
  });

  on(/^UPDATE users SET password_hash = \$1, token_version = token_version \+ 1 WHERE id = \$2(?: RETURNING .*)?$/, (db, [hash, id]) => {
    const u = db.users.find(x => x.id === id);
    if (u) {
      u.password_hash = hash;
      u.token_version = (u.token_version || 0) + 1;
      return rowsOf([{
        id: u.id,
        email: u.email,
        display_name: u.display_name,
        token_version: u.token_version,
        is_owner: u.is_owner,
      }]);
    }
    return rowsOf([]);
  });

  on(/^UPDATE users SET email = \$1, email_verified_at = NULL WHERE id = \$2 RETURNING .*$/, (db, [email, id]) => {
    const u = db.users.find(x => x.id === id);
    if (u) {
      u.email = email;
      u.email_verified_at = null;
      return rowsOf([{
        id: u.id,
        email: u.email,
        display_name: u.display_name,
        token_version: u.token_version || 0,
        is_owner: u.is_owner,
        dob: u.dob || null,
        diagnosis_date: u.diagnosis_date || null,
        target_low: u.target_low != null ? u.target_low : 70,
        target_high: u.target_high != null ? u.target_high : 180,
        units: u.units || 'mg/dL',
      }]);
    }
    return rowsOf([]);
  });

  on(/^UPDATE users SET (?:[a-z_]+ = \$\d+(?:, )?)+ WHERE id = \$1 RETURNING .*$/, (db, params, sql) => {
    const id = params[0];
    const u = db.users.find(x => x.id === id);
    if (!u) return rowsOf([]);

    // Parse out which column corresponds to which parameter index
    const assignments = sql.match(/SET (.+?) WHERE/)[1].split(', ');
    assignments.forEach(assign => {
      const [col, paramPlaceholder] = assign.split(' = ');
      const pIdx = parseInt(paramPlaceholder.replace('$', ''), 10) - 1;
      u[col] = params[pIdx];
    });

    return rowsOf([{
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      email_verified_at: u.email_verified_at,
      created_at: u.created_at || new Date(),
      last_login_at: u.last_login_at || new Date(),
      is_owner: u.is_owner,
      dob: u.dob || null,
      diagnosis_date: u.diagnosis_date || null,
      target_low: u.target_low != null ? u.target_low : 70,
      target_high: u.target_high != null ? u.target_high : 180,
      units: u.units || 'mg/dL',
    }]);
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

  // Viewer-key mint: cap check + insert in one statement (0 rows = cap hit).
  on(/^INSERT INTO device_keys \(user_id, key_hash, key_prefix, label, role\) SELECT \$1::uuid, \$2::text, \$3::text, \$4::text, 'viewer' WHERE \(SELECT COUNT\(\*\) FROM device_keys WHERE user_id = \$1::uuid AND role = 'viewer' AND revoked_at IS NULL\) < \$5::int RETURNING id$/, (db, [userId, hash, prefix, label, cap]) => {
    const active = db.deviceKeys.filter(k => k.user_id === userId && k.role === 'viewer' && !k.revoked_at).length;
    if (!(active < cap)) return rowsOf([]);
    const row = db.addDeviceKeyRow({ userId, hash, prefix, label, role: 'viewer' });
    return rowsOf([{ id: row.id }]);
  });

  on(/^SELECT id, label, key_prefix, created_at, last_used_at, revoked_at FROM device_keys WHERE user_id = \$1 AND role = 'viewer' ORDER BY created_at DESC$/, (db, [userId]) =>
    rowsOf(db.deviceKeys.filter(k => k.user_id === userId && k.role === 'viewer')
      .sort((a, b) => b.created_at - a.created_at)
      .map(k => ({ id: k.id, label: k.label, key_prefix: k.key_prefix, created_at: k.created_at, last_used_at: k.last_used_at, revoked_at: k.revoked_at }))));

  on(/^UPDATE device_keys SET revoked_at = now\(\) WHERE id = \$1 AND user_id = \$2 AND role = 'viewer' AND revoked_at IS NULL RETURNING id$/, (db, [id, userId]) => {
    const k = db.deviceKeys.find(x => x.id === id && x.user_id === userId && x.role === 'viewer' && !x.revoked_at);
    if (!k) return rowsOf([]);
    k.revoked_at = new Date();
    return rowsOf([{ id: k.id }]);
  });

  on(/^UPDATE device_keys SET revoked_at = now\(\) WHERE user_id = \$1 AND revoked_at IS NULL$/, (db, [userId]) => {
    const activeKeys = db.deviceKeys.filter(k => k.user_id === userId && !k.revoked_at);
    activeKeys.forEach(k => { k.revoked_at = new Date(); });
    return rowsOf([]);
  });

  on(/^SELECT id, label, key_prefix, role, created_at, last_used_at, revoked_at FROM device_keys WHERE user_id = \$1 ORDER BY created_at DESC$/, (db, [userId]) =>
    rowsOf(db.deviceKeys.filter(k => k.user_id === userId)
      .sort((a, b) => b.created_at - a.created_at)
      .map(k => ({
        id: k.id,
        label: k.label,
        key_prefix: k.key_prefix,
        role: k.role,
        created_at: k.created_at,
        last_used_at: k.last_used_at,
        revoked_at: k.revoked_at,
      }))));

  on(/^UPDATE device_keys SET revoked_at = now\(\) WHERE id = \$1 AND revoked_at IS NULL RETURNING id, user_id$/, (db, [id]) => {
    const k = db.deviceKeys.find(x => x.id === id && !x.revoked_at);
    if (!k) return rowsOf([]);
    k.revoked_at = new Date();
    return rowsOf([{ id: k.id, user_id: k.user_id }]);
  });

  on(/^SELECT s\.id, s\.owner_id, s\.viewer_id, s\.created_at, ou\.email AS owner_email, vu\.email AS viewer_email FROM shares s JOIN users ou ON s\.owner_id = ou\.id JOIN users vu ON s\.viewer_id = vu\.id WHERE s\.owner_id = \$1 OR s\.viewer_id = \$1 ORDER BY s\.created_at DESC$/, (db, [userId]) => {
    const userShares = db.shares.filter(s => s.owner_id === userId || s.viewer_id === userId);
    return rowsOf(userShares.map(s => {
      const owner = db.users.find(u => u.id === s.owner_id);
      const viewer = db.users.find(u => u.id === s.viewer_id);
      return {
        id: s.id,
        owner_id: s.owner_id,
        viewer_id: s.viewer_id,
        created_at: s.created_at,
        owner_email: owner?.email,
        viewer_email: viewer?.email,
      };
    }));
  });

  // ---- upload path (POST /api/check-trend) ----
  on(/^SELECT MAX\(reading_time_ms\) AS old_max FROM readings WHERE user_id = \$1$/, (db, [userId]) => {
    const times = db.readings.filter(r => r.user_id === userId).map(r => r.reading_time_ms);
    return rowsOf([{ old_max: times.length ? String(Math.max(...times)) : null }]);
  });

  on(/^INSERT INTO readings \(user_id, reading_time_ms, sgv\) VALUES \(\$1, \$2, \$3\) ON CONFLICT \(user_id, reading_time_ms\) DO UPDATE SET sgv = EXCLUDED\.sgv$/, (db, [userId, time, sgv]) => {
    const existing = db.readings.find(r => r.user_id === userId && r.reading_time_ms === time);
    if (existing) existing.sgv = sgv; else db.addReading(userId, time, sgv);
    return rowsOf([]);
  });

  // ---- shares / readings ----
  on(/^SELECT 1 FROM shares WHERE owner_id = \$1 AND viewer_id = \$2$/, (db, [owner, viewer]) =>
    rowsOf(db.shares.filter(s => s.owner_id === owner && s.viewer_id === viewer).map(() => ({ '?column?': 1 }))));

  on(/^SELECT sgv, reading_time_ms FROM readings WHERE user_id = \$1 ORDER BY reading_time_ms DESC LIMIT \$2$/, (db, [userId, limit]) =>
    rowsOf(db.readings.filter(r => r.user_id === userId).sort((a, b) => b.reading_time_ms - a.reading_time_ms).slice(0, limit)
      .map(r => ({ sgv: r.sgv, reading_time_ms: String(r.reading_time_ms) }))));

  on(/^SELECT reading_time_ms, sgv, rate, severity, projected, action FROM readings WHERE user_id = \$1 ORDER BY reading_time_ms DESC LIMIT \$2$/, (db, [userId, limit]) =>
    rowsOf(db.readings.filter(r => r.user_id === userId).sort((a, b) => b.reading_time_ms - a.reading_time_ms).slice(0, limit)
      .map(r => ({
        reading_time_ms: String(r.reading_time_ms),
        sgv: r.sgv,
        rate: r.rate !== undefined ? r.rate : null,
        severity: r.severity || null,
        projected: r.projected !== undefined ? r.projected : null,
        action: r.action || null,
      }))));

  on(/^UPDATE readings SET rate = \$1, severity = \$2, projected = \$3 WHERE user_id = \$4 AND reading_time_ms = \$5$/, (db, [rate, severity, projected, userId, time]) => {
    const row = db.readings.find(r => r.user_id === userId && r.reading_time_ms === Number(time));
    if (row) {
      row.rate = rate;
      row.severity = severity;
      row.projected = projected;
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  });

  on(/^UPDATE readings SET action = \$1 WHERE user_id = \$2 AND reading_time_ms = \$3$/, (db, [action, userId, time]) => {
    const row = db.readings.find(r => r.user_id === userId && r.reading_time_ms === Number(time));
    if (row) {
      row.action = action;
    }
    return { rows: [], rowCount: row ? 1 : 0 };
  });

  on(/^SELECT sgv, reading_time_ms FROM readings WHERE user_id = \$1 AND reading_time_ms >= \$2 ORDER BY reading_time_ms ASC$/, (db, [userId, since]) =>
    rowsOf(db.readings.filter(r => r.user_id === userId && r.reading_time_ms >= since).sort((a, b) => a.reading_time_ms - b.reading_time_ms)
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
