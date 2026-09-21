const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-helpers/harness');

before(h.start);
after(h.stop);
beforeEach(h.resetState);

test('Owner Admin: Non-owner gets 403 on all owner endpoints', async () => {
  const regular = h.fake.addUser({ email: 'regular@aheadt1d.com' });

  const endpoints = [
    { method: 'GET', path: '/api/auth/owner/users' },
    { method: 'GET', path: `/api/auth/owner/users/${regular.id}` },
    { method: 'POST', path: `/api/auth/owner/users/${regular.id}/disable` },
    { method: 'POST', path: `/api/auth/owner/users/${regular.id}/enable` },
    { method: 'DELETE', path: `/api/auth/owner/users/${regular.id}` },
    { method: 'POST', path: '/api/auth/owner/devices/123/revoke' },
  ];

  for (const ep of endpoints) {
    const res = await h.http(ep.method, ep.path, { headers: h.bearer(regular) });
    assert.equal(res.status, 403, `Expected 403 for ${ep.method} ${ep.path}`);
  }
});

test('Owner Admin: Owner can list and search users', async () => {
  const owner = h.fake.addUser({ email: 'ryan@aheadt1d.com' });
  owner.is_owner = true;

  const userA = h.fake.addUser({ email: 'alice@example.com' });
  userA.display_name = 'Alice Smith';
  const userB = h.fake.addUser({ email: 'bob@example.com' });

  // List all
  const res = await h.http('GET', '/api/auth/owner/users', { headers: h.bearer(owner) });
  assert.equal(res.status, 200);
  assert.ok(res.json.users.length >= 3);

  // Search by query
  const searchRes = await h.http('GET', '/api/auth/owner/users?q=alice', { headers: h.bearer(owner) });
  assert.equal(searchRes.status, 200);
  assert.equal(searchRes.json.users.length, 1);
  assert.equal(searchRes.json.users[0].email, 'alice@example.com');
});

test('Owner Admin: Owner can view user details, devices, and shares', async () => {
  const owner = h.fake.addUser({ email: 'ryan@aheadt1d.com' });
  owner.is_owner = true;

  const target = h.fake.addUser({ email: 'follower@example.com' });
  h.fake.addDeviceKeyRow({ userId: target.id, hash: 'h123', prefix: 'ahead_dev_01' });
  h.fake.addShare(owner.id, target.id);

  const res = await h.http('GET', `/api/auth/owner/users/${target.id}`, { headers: h.bearer(owner) });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.email, 'follower@example.com');
  assert.equal(res.json.devices.length, 1);
  assert.equal(res.json.devices[0].keyPrefix, 'ahead_dev_01');
  assert.equal(res.json.shares.length, 1);
});

test('Owner Admin: Owner can disable and re-enable a user, but cannot disable own account', async () => {
  const owner = h.fake.addUser({ email: 'ryan@aheadt1d.com' });
  owner.is_owner = true;

  const target = h.fake.addUser({ email: 'suspend@example.com' });

  // Disallow disabling oneself
  const selfDisable = await h.http('POST', `/api/auth/owner/users/${owner.id}/disable`, { headers: h.bearer(owner) });
  assert.equal(selfDisable.status, 400);

  // Disable target
  const disableRes = await h.http('POST', `/api/auth/owner/users/${target.id}/disable`, { headers: h.bearer(owner) });
  assert.equal(disableRes.status, 200);
  assert.equal(disableRes.json.disabled, true);
  assert.equal(target.status, 'disabled');

  // Enable target
  const enableRes = await h.http('POST', `/api/auth/owner/users/${target.id}/enable`, { headers: h.bearer(owner) });
  assert.equal(enableRes.status, 200);
  assert.equal(enableRes.json.enabled, true);
  assert.equal(target.status, 'active');
});

test('Owner Admin: Owner can delete a user, but cannot delete own account or another owner', async () => {
  const owner = h.fake.addUser({ email: 'ryan@aheadt1d.com' });
  owner.is_owner = true;

  const target = h.fake.addUser({ email: 'delete-me@example.com' });
  h.fake.addDeviceKeyRow({ userId: target.id, hash: 'h456' });

  // Disallow self deletion
  const selfDelete = await h.http('DELETE', `/api/auth/owner/users/${owner.id}`, { headers: h.bearer(owner) });
  assert.equal(selfDelete.status, 400);

  // Delete target
  const deleteRes = await h.http('DELETE', `/api/auth/owner/users/${target.id}`, { headers: h.bearer(owner) });
  assert.equal(deleteRes.status, 200);
  assert.equal(deleteRes.json.deleted, true);

  // Verify user is gone from db and devices cascaded
  assert.equal(h.fake.users.find(u => u.id === target.id), undefined);
  assert.equal(h.fake.deviceKeys.filter(k => k.user_id === target.id).length, 0);
});

test('Owner Telemetry Log: Non-owner gets 403', async () => {
  const regular = h.fake.addUser({ email: 'regular@aheadt1d.com' });
  const res = await h.http('GET', '/api/auth/owner/telemetry-log', { headers: h.bearer(regular) });
  assert.equal(res.status, 403);
});

test('Owner Telemetry Log: Owner gets 200, strictly returns owner-only readings, marks backfilled rows', async () => {
  const owner = h.fake.addUser({ email: 'ryan@aheadt1d.com' });
  owner.is_owner = true;

  const otherUser = h.fake.addUser({ email: 'other@aheadt1d.com' });

  const now = Date.now();
  // Owner readings
  h.fake.addReading(owner.id, now - 600000, 235);
  h.fake.addReading(owner.id, now - 300000, 240);
  const readingRow = h.fake.readings.find(r => r.user_id === owner.id && r.reading_time_ms === now - 300000);
  readingRow.rate = 1.0;
  readingRow.severity = 'red';
  readingRow.projected = 255;
  readingRow.action = 'audible_red';

  // Other user reading (should NEVER be returned to owner even if ?userId is passed)
  h.fake.addReading(otherUser.id, now - 100000, 110);

  // Attempt to pass ?userId=otherUser.id -> Must be ignored and strictly return owner data
  const res = await h.http('GET', `/api/auth/owner/telemetry-log?userId=${otherUser.id}`, { headers: h.bearer(owner) });
  assert.equal(res.status, 200);
  assert.equal(res.json.userId, owner.id);
  assert.equal(res.json.entries.length, 2);

  // First entry has explicit action
  const latest = res.json.entries[0];
  assert.equal(latest.sgv, 240);
  assert.equal(latest.action, 'audible_red');
  assert.equal(latest.isBackfilled, false);

  // Second entry has no action or rate recorded, marked backfilled
  const older = res.json.entries[1];
  assert.equal(older.sgv, 235);
  assert.equal(older.isBackfilled, true);
  assert.equal(older.action, 'backfilled');
});

test('Alerts Action: Records action for reading', async () => {
  const user = h.fake.addUser({ email: 'devuser@aheadt1d.com' });
  const now = Date.now();
  h.fake.addReading(user.id, now, 235);

  const res = await h.http('POST', '/api/alerts/action', {
    headers: h.bearer(user),
    body: { readingTime: now, action: 'silent_yellow_update' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.equal(res.json.action, 'silent_yellow_update');

  const row = h.fake.readings.find(r => r.user_id === user.id && r.reading_time_ms === now);
  assert.equal(row.action, 'silent_yellow_update');
});
