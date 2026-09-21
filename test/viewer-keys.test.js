// Task 2: read-only viewer keys.
//   - POST/GET /api/viewer-keys, POST /api/viewer-keys/:id/revoke  (JWT only)
//   - X-Ahead-Viewer-Key works on EXACTLY GET /api/readings and
//     GET /api/shares/accessible, and nowhere else
//   - requireDeviceKey accepts only role='uploader'
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('../test-helpers/harness');

before(h.start);
after(h.stop);
beforeEach(h.resetState);

const NOW = Date.now();
function seedReadings(user) {
  h.fake.addReading(user.id, NOW - 600000, 110);
  h.fake.addReading(user.id, NOW - 300000, 115);
  h.fake.addReading(user.id, NOW, 120);
}
const viewerHeader = raw => ({ 'X-Ahead-Viewer-Key': raw });
const apiKeyHeader = raw => ({ 'X-Ahead-Api-Key': raw });

// ---------------------------------------------------------------------
// Minting / listing / revoking (JWT)
// ---------------------------------------------------------------------

test('mint: 201 with exactly {id, key}; only the hash is stored', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const res = await h.http('POST', '/api/viewer-keys', { headers: h.bearer(user), body: { label: 'Mom\'s phone' } });
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.json).sort(), ['id', 'key']);
  assert.match(res.json.key, /^ahead_vk_[A-Za-z0-9_-]{43}$/);

  const rows = h.fake.deviceKeys;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, res.json.id);
  assert.equal(rows[0].role, 'viewer');
  assert.equal(rows[0].user_id, user.id);
  assert.equal(rows[0].label, "Mom's phone");
  assert.equal(rows[0].key_prefix, res.json.key.slice(0, 12));
  assert.equal(rows[0].key_hash, crypto.createHmac('sha256', process.env.DEVICE_KEY_PEPPER).update(res.json.key).digest('hex'));
  // the raw key is never persisted anywhere
  assert.equal(JSON.stringify(h.fake.deviceKeys).includes(res.json.key), false);
});

test('mint: label is optional, blank becomes null, non-strings are a 400', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  let res = await h.http('POST', '/api/viewer-keys', { headers: h.bearer(user), body: {} });
  assert.equal(res.status, 201);
  assert.equal(h.fake.deviceKeys[0].label, null);
  res = await h.http('POST', '/api/viewer-keys', { headers: h.bearer(user), body: { label: '   ' } });
  assert.equal(res.status, 201);
  assert.equal(h.fake.deviceKeys[1].label, null);
  res = await h.http('POST', '/api/viewer-keys', { headers: h.bearer(user), body: { label: { evil: true } } });
  assert.equal(res.status, 400);
  assert.equal(h.fake.deviceKeys.length, 2);
});

test('mint: needs the user JWT - no credential, a viewer key, or an uploader key are all 401', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const viewer = h.addKey(user, { role: 'viewer' });
  const uploader = h.addKey(user, { role: 'uploader' });
  const before = h.fake.deviceKeys.length;

  assert.equal((await h.http('POST', '/api/viewer-keys', { body: {} })).status, 401);
  assert.equal((await h.http('POST', '/api/viewer-keys', { headers: viewerHeader(viewer.raw), body: {} })).status, 401);
  assert.equal((await h.http('POST', '/api/viewer-keys', { headers: apiKeyHeader(uploader.raw), body: {} })).status, 401);
  assert.equal(h.fake.deviceKeys.length, before);
});

test('cap: the 11th active viewer key is a 409 with a clear message; revoking frees a slot', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const other = h.fake.addUser({ email: 'other@example.com' });
  // Other people's keys and the user's own uploader keys must not count.
  for (let i = 0; i < 12; i++) h.addKey(other, { role: 'viewer' });
  for (let i = 0; i < 12; i++) h.addKey(user, { role: 'uploader' });

  const ids = [];
  for (let i = 0; i < 10; i++) {
    const res = await h.http('POST', '/api/viewer-keys', { headers: h.bearer(user), body: {} });
    assert.equal(res.status, 201, `mint #${i + 1}`);
    ids.push(res.json.id);
  }
  const over = await h.http('POST', '/api/viewer-keys', { headers: h.bearer(user), body: {} });
  assert.equal(over.status, 409);
  assert.match(over.json.error, /10 active viewer keys/);
  assert.match(over.json.error, /[Rr]evoke/);
  assert.equal(h.fake.deviceKeys.filter(k => k.user_id === user.id && k.role === 'viewer').length, 10);

  const rev = await h.http('POST', `/api/viewer-keys/${ids[0]}/revoke`, { headers: h.bearer(user) });
  assert.equal(rev.status, 200);
  const again = await h.http('POST', '/api/viewer-keys', { headers: h.bearer(user), body: {} });
  assert.equal(again.status, 201);
});

test('list: only the caller\'s viewer keys, with exactly the documented fields and never the raw key or hash', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const other = h.fake.addUser({ email: 'other@example.com' });
  const mine = h.addKey(user, { role: 'viewer' });
  const revoked = h.addKey(user, { role: 'viewer', revoked: true });
  h.addKey(user, { role: 'uploader' });   // not a viewer key -> not listed
  h.addKey(other, { role: 'viewer' });    // someone else's -> not listed

  const res = await h.http('GET', '/api/viewer-keys', { headers: h.bearer(user) });
  assert.equal(res.status, 200);
  assert.equal(res.json.length, 2);
  assert.deepEqual(res.json.map(r => r.id).sort(), [mine.row.id, revoked.row.id].sort());
  for (const item of res.json) {
    assert.deepEqual(Object.keys(item).sort(), ['created_at', 'id', 'key_prefix', 'label', 'last_used_at', 'revoked_at']);
  }
  assert.notEqual(res.json.find(r => r.id === revoked.row.id).revoked_at, null);
  assert.equal(res.json.find(r => r.id === mine.row.id).revoked_at, null);
  assert.equal(res.text.includes(mine.raw), false);
  assert.equal(res.text.includes(mine.row.key_hash), false);
});

test('list: needs a JWT (a viewer key cannot list keys)', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const viewer = h.addKey(user, { role: 'viewer' });
  assert.equal((await h.http('GET', '/api/viewer-keys')).status, 401);
  assert.equal((await h.http('GET', '/api/viewer-keys', { headers: viewerHeader(viewer.raw) })).status, 401);
});

test('revoke: own key -> 200, and the key stops working straight away', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const key = h.addKey(user, { role: 'viewer' });
  assert.equal((await h.http('GET', '/api/readings', { headers: viewerHeader(key.raw) })).status, 200);

  const rev = await h.http('POST', `/api/viewer-keys/${key.row.id}/revoke`, { headers: h.bearer(user) });
  assert.equal(rev.status, 200);
  assert.deepEqual(rev.json, { revoked: true });
  assert.equal((await h.http('GET', '/api/readings', { headers: viewerHeader(key.raw) })).status, 401);
});

test("revoke: someone else's key -> 404 and it stays alive", async () => {
  const owner = h.fake.addUser({ email: 'owner@example.com' });
  const attacker = h.fake.addUser({ email: 'attacker@example.com' });
  const key = h.addKey(owner, { role: 'viewer' });

  const res = await h.http('POST', `/api/viewer-keys/${key.row.id}/revoke`, { headers: h.bearer(attacker) });
  assert.equal(res.status, 404);
  assert.equal(key.row.revoked_at, null);
  assert.equal((await h.http('GET', '/api/readings', { headers: viewerHeader(key.raw) })).status, 200);
});

test('revoke: unknown id, non-UUID id, an uploader key id, and an already-revoked id are all 404', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const uploader = h.addKey(user, { role: 'uploader' });
  const done = h.addKey(user, { role: 'viewer', revoked: true });
  for (const id of [crypto.randomUUID(), 'not-a-uuid', uploader.row.id, done.row.id]) {
    const res = await h.http('POST', `/api/viewer-keys/${id}/revoke`, { headers: h.bearer(user) });
    assert.equal(res.status, 404, id);
  }
  assert.equal(uploader.row.revoked_at, null);   // viewer-revoke can't touch device keys
});

test('revoke: a viewer key cannot revoke keys (JWT only)', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const key = h.addKey(user, { role: 'viewer' });
  const res = await h.http('POST', `/api/viewer-keys/${key.row.id}/revoke`, { headers: viewerHeader(key.raw) });
  assert.equal(res.status, 401);
  assert.equal(key.row.revoked_at, null);
});

// ---------------------------------------------------------------------
// Using a viewer key: the two allowed routes
// ---------------------------------------------------------------------

test('GET /api/readings with a viewer key returns the owner\'s own data', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  seedReadings(user);
  const key = h.addKey(user, { role: 'viewer' });

  const res = await h.http('GET', '/api/readings', { headers: viewerHeader(key.raw) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.entries.map(e => e.sgv), [110, 115, 120]);   // oldest first, as with a JWT

  // explicit ownerId === its own id is the same thing
  const res2 = await h.http('GET', `/api/readings?ownerId=${user.id}&count=2`, { headers: viewerHeader(key.raw) });
  assert.equal(res2.status, 200);
  assert.equal(res2.json.entries.length, 2);
});

test('GET /api/readings with a viewer key for a SHARED owner works; for an unshared owner it is 403', async () => {
  const owner = h.fake.addUser({ email: 'owner@example.com' });
  const stranger = h.fake.addUser({ email: 'stranger@example.com' });
  const caregiver = h.fake.addUser({ email: 'caregiver@example.com' });
  seedReadings(owner);
  seedReadings(stranger);
  h.fake.addShare(owner.id, caregiver.id);
  const key = h.addKey(caregiver, { role: 'viewer' });

  const ok = await h.http('GET', `/api/readings?ownerId=${owner.id}`, { headers: viewerHeader(key.raw) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.entries.length, 3);

  const denied = await h.http('GET', `/api/readings?ownerId=${stranger.id}`, { headers: viewerHeader(key.raw) });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.entries, undefined);
});

test('authorization is unchanged for a viewer key: a share granted TO the key\'s owner only, never the other direction', async () => {
  const owner = h.fake.addUser({ email: 'owner@example.com' });
  const caregiver = h.fake.addUser({ email: 'caregiver@example.com' });
  seedReadings(caregiver);
  h.fake.addShare(owner.id, caregiver.id);           // caregiver may read owner...
  const ownerKey = h.addKey(owner, { role: 'viewer' });
  // ...but the owner's viewer key must NOT read the caregiver's stream.
  const res = await h.http('GET', `/api/readings?ownerId=${caregiver.id}`, { headers: viewerHeader(ownerKey.raw) });
  assert.equal(res.status, 403);
});

test('GET /api/readings with a viewer key still validates ownerId', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const key = h.addKey(user, { role: 'viewer' });
  const res = await h.http('GET', '/api/readings?ownerId=not-a-uuid', { headers: viewerHeader(key.raw) });
  assert.equal(res.status, 400);
});

test('GET /api/shares/accessible with a viewer key lists self + shared owners, like a JWT', async () => {
  const owner = h.fake.addUser({ email: 'owner@example.com' });
  const caregiver = h.fake.addUser({ email: 'caregiver@example.com' });
  h.fake.addShare(owner.id, caregiver.id);
  const key = h.addKey(caregiver, { role: 'viewer' });

  const viaKey = await h.http('GET', '/api/shares/accessible', { headers: viewerHeader(key.raw) });
  const viaJwt = await h.http('GET', '/api/shares/accessible', { headers: h.bearer(caregiver) });
  assert.equal(viaKey.status, 200);
  assert.deepEqual(viaKey.json, viaJwt.json);
  assert.deepEqual(viaKey.json, [
    { ownerId: caregiver.id, ownerEmail: 'caregiver@example.com', isSelf: true },
    { ownerId: owner.id, ownerEmail: 'owner@example.com', isSelf: false },
  ]);
});

test('the JWT still works on both routes exactly as before', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  seedReadings(user);
  assert.equal((await h.http('GET', '/api/readings', { headers: h.bearer(user) })).status, 200);
  assert.equal((await h.http('GET', '/api/shares/accessible', { headers: h.bearer(user) })).status, 200);
});

test('last_used_at is updated when a viewer key is used', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const key = h.addKey(user, { role: 'viewer' });
  assert.equal(key.row.last_used_at, null);
  await h.http('GET', '/api/readings', { headers: viewerHeader(key.raw) });
  assert.ok(key.row.last_used_at instanceof Date);

  key.row.last_used_at = null;
  await h.http('GET', '/api/shares/accessible', { headers: viewerHeader(key.raw) });
  assert.ok(key.row.last_used_at instanceof Date);
});

// ---------------------------------------------------------------------
// Bad viewer keys -> 401, same generic style as device keys
// ---------------------------------------------------------------------

test('revoked, unknown, wrong-pepper and disabled-user viewer keys are all 401 with a generic error', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const disabled = h.fake.addUser({ email: 'off@example.com', status: 'disabled' });

  const revoked = h.addKey(user, { role: 'viewer', revoked: true });
  const disabledKey = h.addKey(disabled, { role: 'viewer' });
  // A key stored under a DIFFERENT pepper (what a leaked/old hash would look like).
  const wrongPepper = h.auth.generateViewerKey();
  const wrongHash = crypto.createHmac('sha256', 'some-other-pepper').update(wrongPepper.raw).digest('hex');
  h.fake.addDeviceKeyRow({ userId: user.id, hash: wrongHash, role: 'viewer' });

  const cases = {
    revoked: revoked.raw,
    unknown: h.auth.generateViewerKey().raw,
    wrongPepper: wrongPepper.raw,
    disabledUser: disabledKey.raw,
    garbage: 'x',
  };
  for (const [name, raw] of Object.entries(cases)) {
    for (const path of ['/api/readings', '/api/shares/accessible']) {
      const res = await h.http('GET', path, { headers: viewerHeader(raw) });
      assert.equal(res.status, 401, `${name} on ${path}`);
      assert.match(res.json.error, /Unknown, revoked, or disabled viewer key/);
    }
  }
});

test('a bad viewer key never falls through to a valid Bearer token on the same request', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const res = await h.http('GET', '/api/readings', {
    headers: { ...h.bearer(user), ...viewerHeader(h.auth.generateViewerKey().raw) },
  });
  assert.equal(res.status, 401);
});

test('an UPLOADER key is not accepted on the viewer routes, in either header', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  seedReadings(user);
  const uploader = h.addKey(user, { role: 'uploader' });
  for (const path of ['/api/readings', '/api/shares/accessible']) {
    assert.equal((await h.http('GET', path, { headers: viewerHeader(uploader.raw) })).status, 401, `as viewer key on ${path}`);
    assert.equal((await h.http('GET', path, { headers: apiKeyHeader(uploader.raw) })).status, 401, `as api key on ${path}`);
  }
});

// ---------------------------------------------------------------------
// A viewer key must authenticate NOWHERE else
// ---------------------------------------------------------------------

test('a viewer key is rejected on the upload routes (both headers) and stores nothing', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const key = h.addKey(user, { role: 'viewer' });
  const body = { readings: [{ date: NOW - 300000, sgv: 100 }, { date: NOW, sgv: 105 }] };

  for (const headers of [viewerHeader(key.raw), apiKeyHeader(key.raw), { ...viewerHeader(key.raw), ...apiKeyHeader(key.raw) }]) {
    assert.equal((await h.http('POST', '/api/check-trend', { headers, body })).status, 401);
    assert.equal((await h.http('POST', '/analyze', { headers, body })).status, 401);
  }
  assert.equal(h.fake.readings.length, 0);
});

test('a viewer key cannot delete readings (both headers) - the data survives', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  seedReadings(user);
  const key = h.addKey(user, { role: 'viewer' });

  for (const headers of [viewerHeader(key.raw), apiKeyHeader(key.raw)]) {
    for (const q of ['', '?all=true', `?since=${NOW - 1000000}`]) {
      const res = await h.http('DELETE', `/api/readings${q}`, { headers });
      assert.equal(res.status, 401, `DELETE ${q}`);
    }
  }
  assert.equal(h.fake.readings.length, 3);
});

test('a viewer key cannot touch devices', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const key = h.addKey(user, { role: 'viewer' });
  const uploader = h.addKey(user, { role: 'uploader' });
  for (const headers of [viewerHeader(key.raw), apiKeyHeader(key.raw)]) {
    assert.equal((await h.http('GET', '/api/devices', { headers })).status, 401);
    assert.equal((await h.http('POST', '/api/devices', { headers, body: { label: 'x' } })).status, 401);
    assert.equal((await h.http('POST', `/api/devices/${uploader.row.id}/revoke`, { headers })).status, 401);
  }
  assert.equal(h.fake.deviceKeys.length, 2);
  assert.equal(uploader.row.revoked_at, null);
});

test('a viewer key cannot touch shares (list, create, delete) or accessible-writes', async () => {
  const owner = h.fake.addUser({ email: 'owner@example.com' });
  const friend = h.fake.addUser({ email: 'friend@example.com' });
  h.fake.addShare(owner.id, friend.id);
  const key = h.addKey(owner, { role: 'viewer' });
  const shareId = h.fake.shares[0].id;

  for (const headers of [viewerHeader(key.raw), apiKeyHeader(key.raw)]) {
    assert.equal((await h.http('GET', '/api/shares', { headers })).status, 401);
    assert.equal((await h.http('POST', '/api/shares', { headers, body: { viewerEmail: 'friend@example.com' } })).status, 401);
    assert.equal((await h.http('DELETE', `/api/shares/${shareId}`, { headers })).status, 401);
  }
  assert.equal(h.fake.shares.length, 1);
});

test('a viewer key cannot delete the account or use any other account route', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const key = h.addKey(user, { role: 'viewer' });
  for (const headers of [viewerHeader(key.raw), apiKeyHeader(key.raw)]) {
    assert.equal((await h.http('DELETE', '/api/auth/account', { headers, body: { password: 'whatever-it-is' } })).status, 401);
    assert.equal((await h.http('POST', '/api/auth/verify-email/resend', { headers })).status, 401);
  }
  assert.equal(h.fake.users.length, 1);
});

test('a viewer key cannot reach any admin route', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const key = h.addKey(user, { role: 'viewer' });
  const before = h.fake.log.length;
  for (const headers of [viewerHeader(key.raw), apiKeyHeader(key.raw), { ...h.bearer(user), ...viewerHeader(key.raw) }]) {
    for (const [method, path] of [
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/admins'],
      ['GET', '/api/admin/audit-log'],
      ['GET', '/api/admin/security/flags'],
      ['POST', `/api/admin/users/${user.id}/disable`],
      ['POST', `/api/admin/devices/${key.row.id}/revoke`],
    ]) {
      const res = await h.http(method, path, { headers, body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  }
  assert.equal(key.row.revoked_at, null);
  assert.equal(user.status, 'active');
  assert.equal(h.fake.log.length, before, 'no DB access at all: rejected before any admin query ran');
});

// ---------------------------------------------------------------------
// requireDeviceKey: uploader-only, and existing uploader keys unchanged
// ---------------------------------------------------------------------

test('requireDeviceKey (middleware level) rejects a role=viewer row and accepts a role=uploader row', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const viewer = h.addKey(user, { role: 'viewer' });
  const uploader = h.addKey(user, { role: 'uploader' });

  function run(raw) {
    return new Promise((resolve, reject) => {
      const req = { get: name => (name === 'X-Ahead-Api-Key' ? raw : undefined) };
      const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code, body, req }); } };
      h.auth.requireDeviceKey(req, res, () => resolve({ code: 'next', req })).catch(reject);
    });
  }

  const rejected = await run(viewer.raw);
  assert.equal(rejected.code, 401);
  assert.equal(rejected.req.userId, undefined);
  assert.equal(viewer.row.last_used_at, null);

  const accepted = await run(uploader.raw);
  assert.equal(accepted.code, 'next');
  assert.equal(accepted.req.userId, user.id);
  assert.ok(uploader.row.last_used_at instanceof Date);
});

test('the role column decides, not the key format: a viewer row with a device-style key is still refused as an uploader', async () => {
  // Belt and braces for the important security fix: what decides is the role
  // column, not how the raw key looks.
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const { raw, hash } = h.auth.generateDeviceKey();
  h.fake.addDeviceKeyRow({ userId: user.id, hash, role: 'viewer' });
  const res = await h.http('POST', '/api/check-trend', {
    headers: apiKeyHeader(raw),
    body: { readings: [{ date: NOW - 300000, sgv: 100 }, { date: NOW, sgv: 105 }] },
  });
  assert.equal(res.status, 401);
});

test('an existing uploader key still uploads end to end, byte-for-byte as before', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const uploader = h.addKey(user, { role: 'uploader' });
  const res = await h.http('POST', '/api/check-trend', {
    headers: apiKeyHeader(uploader.raw),
    body: { readings: [{ date: NOW - 300000, sgv: 100 }, { date: NOW, sgv: 105 }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.processed.length, 1);
  assert.equal(h.fake.readings.length, 2);
  assert.ok(uploader.row.last_used_at instanceof Date);
  // uploader keys can still delete their own readings (unchanged behaviour)
  assert.equal((await h.http('DELETE', '/api/readings?all=true', { headers: apiKeyHeader(uploader.raw) })).status, 200);
  assert.equal(h.fake.readings.length, 0);
});

test('revoked and missing uploader keys are still refused as before', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const revoked = h.addKey(user, { role: 'uploader', revoked: true });
  const res = await h.http('POST', '/api/check-trend', { headers: apiKeyHeader(revoked.raw), body: {} });
  assert.equal(res.status, 401);
  assert.equal((await h.http('POST', '/api/check-trend', { body: {} })).status, 401);
});

test('deploy-order safety net: with the role column NOT yet migrated, uploader keys keep working', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const uploader = h.addKey(user, { role: 'uploader' });
  h.fake.missingRoleColumn = true;
  const res = await h.http('POST', '/api/check-trend', {
    headers: apiKeyHeader(uploader.raw),
    body: { readings: [{ date: NOW - 300000, sgv: 100 }, { date: NOW, sgv: 105 }] },
  });
  assert.equal(res.status, 200);
  // ...but nothing new can be minted or used as a viewer key until migrated (500, not a security hole)
  assert.equal((await h.http('POST', '/api/viewer-keys', { headers: h.bearer(user), body: {} })).status, 500);
  assert.equal((await h.http('GET', '/api/readings', { headers: viewerHeader('ahead_vk_x') })).status, 500);
});

test('an unrelated database error on the uploader lookup is NOT swallowed by the fallback', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const uploader = h.addKey(user, { role: 'uploader' });
  h.fake.failOn = sql => sql.includes('FROM device_keys dk');
  const res = await h.http('POST', '/api/check-trend', { headers: apiKeyHeader(uploader.raw), body: {} });
  assert.equal(res.status, 500);
});

test('password reset confirmation revokes all device keys (uploader and viewer) and notifies user', async () => {
  const user = h.fake.addUser({ email: 'owner@example.com' });
  const otherUser = h.fake.addUser({ email: 'other@example.com' });
  const uploader = h.addKey(user, { role: 'uploader' });
  const viewer = h.addKey(user, { role: 'viewer' });
  const otherUploader = h.addKey(otherUser, { role: 'uploader' });

  const { raw, hash } = require('../auth').generateEmailToken();
  h.fake.emailTokens.push({
    user_id: user.id,
    purpose: 'password_reset',
    token_hash: hash,
    expires_at: new Date(Date.now() + 60000),
    used_at: null,
    created_at: new Date(),
  });

  const res = await h.http('POST', '/api/auth/password-reset/confirm', {
    body: { token: raw, newPassword: 'a-brand-new-secure-password' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.reset, true);

  // Both uploader and viewer keys for this user are revoked
  assert.ok(uploader.row.revoked_at);
  assert.ok(viewer.row.revoked_at);

  // Other user's key is NOT revoked
  assert.equal(otherUploader.row.revoked_at, null);

  // User's token_version bumped
  assert.equal(user.token_version, 1);

  // Password-changed email was sent to user
  assert.ok(h.mailer.sent.some(m => m.kind === 'changed' && m.to === 'owner@example.com'));

  // Subsequent uploads with old uploader key fail with 401
  const uploadRes = await h.http('POST', '/api/check-trend', { headers: apiKeyHeader(uploader.raw), body: {} });
  assert.equal(uploadRes.status, 401);

  // Subsequent reads with old viewer key fail with 401
  const viewerRes = await h.http('GET', '/api/readings', { headers: viewerHeader(viewer.raw) });
  assert.equal(viewerRes.status, 401);
});
