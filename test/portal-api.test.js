const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-helpers/harness');

before(h.start);
after(h.stop);
beforeEach(h.resetState);

test('Portal API: GET /api/auth/me returns authenticated user details', async () => {
  const user = h.fake.addUser({ email: 'ryan@aheadt1d.com', verified: true });
  user.display_name = 'Ryan Singer';

  const res = await h.http('GET', '/api/auth/me', { headers: h.bearer(user) });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.email, 'ryan@aheadt1d.com');
  assert.equal(res.json.user.displayName, 'Ryan Singer');
  assert.equal(res.json.user.emailVerified, true);
});

test('Portal API: GET /api/auth/me requires authentication', async () => {
  const res = await h.http('GET', '/api/auth/me');
  assert.equal(res.status, 401);
});

test('Portal API: POST /api/auth/change-password validates password and revokes devices', async () => {
  const { hashPassword } = require('../auth');
  const user = h.fake.addUser({ email: 'change@aheadt1d.com', verified: true });
  user.password_hash = await hashPassword('oldpassword123');

  // Give the user an active device key
  const { hash, prefix } = require('../auth').generateDeviceKey();
  h.fake.addDeviceKeyRow({ userId: user.id, hash, prefix });

  // Fails with wrong current password
  const failRes = await h.http('POST', '/api/auth/change-password', {
    headers: h.bearer(user),
    body: { oldPassword: 'wrongpassword', newPassword: 'newsecurepassword99' },
  });
  assert.equal(failRes.status, 401);

  // Fails with too short new password
  const shortRes = await h.http('POST', '/api/auth/change-password', {
    headers: h.bearer(user),
    body: { oldPassword: 'oldpassword123', newPassword: 'short' },
  });
  assert.equal(shortRes.status, 400);

  // Succeeds with correct passwords
  const okRes = await h.http('POST', '/api/auth/change-password', {
    headers: h.bearer(user),
    body: { oldPassword: 'oldpassword123', newPassword: 'brandnewsecurepassword100' },
  });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.json.success, true);
  assert.ok(okRes.json.token);

  // Verify device keys got revoked
  const devices = h.fake.deviceKeys.filter(k => k.user_id === user.id);
  assert.ok(devices.length > 0);
  assert.ok(devices.every(k => k.revoked_at !== null));
});

test('Portal API: GET /api/readings/stats returns clean zeroes when no readings exist', async () => {
  const user = h.fake.addUser({ email: 'empty@aheadt1d.com' });
  const res = await h.http('GET', '/api/readings/stats?days=14', { headers: h.bearer(user) });

  assert.equal(res.status, 200);
  assert.equal(res.json.totalReadings, 0);
  assert.equal(res.json.metrics, null);
  assert.equal(res.json.tir, null);
  assert.equal(res.json.hourlyAgp.length, 0);
});

test('Portal API: GET /api/readings/stats calculates accurate clinical TIR and AGP metrics', async () => {
  const user = h.fake.addUser({ email: 'stats@aheadt1d.com' });
  const now = Date.now();
  // Add readings across ranges:
  // 1x Very Low (<54): 48
  // 1x Low (54-69): 62
  // 6x In Range (70-180): 100, 110, 120, 130, 140, 150
  // 1x High (181-250): 210
  // 1x Very High (>250): 280
  // Total = 10 readings. Sum = 1250, Mean = 125.0
  const values = [48, 62, 100, 110, 120, 130, 140, 150, 210, 280];
  values.forEach((sgv, i) => {
    h.fake.addReading(user.id, now - (i * 3600_000), sgv);
  });

  const res = await h.http('GET', '/api/readings/stats?days=14', { headers: h.bearer(user) });

  assert.equal(res.status, 200);
  assert.equal(res.json.totalReadings, 10);
  assert.equal(res.json.metrics.mean, 135);
  assert.equal(res.json.metrics.min, 48);
  assert.equal(res.json.metrics.max, 280);

  // TIR counts and percents (out of 10):
  assert.equal(res.json.tir.veryLow.count, 1);
  assert.equal(res.json.tir.veryLow.percent, 10);
  assert.equal(res.json.tir.low.count, 1);
  assert.equal(res.json.tir.low.percent, 10);
  assert.equal(res.json.tir.inRange.count, 6);
  assert.equal(res.json.tir.inRange.percent, 60);
  assert.equal(res.json.tir.high.count, 1);
  assert.equal(res.json.tir.high.percent, 10);
  assert.equal(res.json.tir.veryHigh.count, 1);
  assert.equal(res.json.tir.veryHigh.percent, 10);

  // GMI calculation: 3.31 + (0.02392 * 135) = 6.5
  assert.equal(res.json.metrics.gmi, 6.5);

  // 24 hourly buckets
  assert.equal(res.json.hourlyAgp.length, 24);
});

test('Portal API: GET /api/readings/stats respects caregiver sharing permissions', async () => {
  const patient = h.fake.addUser({ email: 'patient@aheadt1d.com' });
  const caregiver = h.fake.addUser({ email: 'caregiver@aheadt1d.com' });
  const stranger = h.fake.addUser({ email: 'stranger@aheadt1d.com' });

  h.fake.addShare(patient.id, caregiver.id);
  h.fake.addReading(patient.id, Date.now() - 1000, 115);

  // Caregiver can read patient's stats with ?ownerId
  const allowedRes = await h.http('GET', `/api/readings/stats?ownerId=${patient.id}`, { headers: h.bearer(caregiver) });
  assert.equal(allowedRes.status, 200);
  assert.equal(allowedRes.json.totalReadings, 1);

  // Stranger is rejected with 403
  const blockedRes = await h.http('GET', `/api/readings/stats?ownerId=${patient.id}`, { headers: h.bearer(stranger) });
  assert.equal(blockedRes.status, 403);
});

test('Portal API: GET /api/readings/export downloads CSV formatted for doctors', async () => {
  const user = h.fake.addUser({ email: 'export@aheadt1d.com' });
  h.fake.addReading(user.id, Date.now() - 60000, 125); // epoch ms

  const res = await h.http('GET', '/api/readings/export?days=14', { headers: h.bearer(user) });

  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type').includes('text/csv'));
  assert.ok(res.headers.get('content-disposition').includes('ahead-glucose-14days.csv'));
  assert.ok(res.text.includes('Timestamp (UTC),Local Time,Glucose (mg/dL)'));
  assert.ok(res.text.includes('125'));
});

test('Portal API: Owner vs Friend permission separation', async () => {
  const friend = h.fake.addUser({ email: 'friend@aheadt1d.com' });
  const owner = h.fake.addUser({ email: 'ryan@aheadt1d.com' });
  owner.is_owner = true;

  // Friend cannot access owner system health (gets 403)
  const friendRes = await h.http('GET', '/api/auth/system-health', { headers: h.bearer(friend) });
  assert.equal(friendRes.status, 403);

  // Friend's /me shows isOwner: false
  const friendMe = await h.http('GET', '/api/auth/me', { headers: h.bearer(friend) });
  assert.equal(friendMe.json.user.isOwner, false);

  // Owner can access system health (gets 200)
  const ownerRes = await h.http('GET', '/api/auth/system-health', { headers: h.bearer(owner) });
  assert.equal(ownerRes.status, 200);
  assert.equal(ownerRes.json.status, 'healthy');
  assert.equal(ownerRes.json.database, 'connected');
  assert.ok(typeof ownerRes.json.counts.totalUsers === 'number');

  // Owner's /me shows isOwner: true
  const ownerMe = await h.http('GET', '/api/auth/me', { headers: h.bearer(owner) });
  assert.equal(ownerMe.json.user.isOwner, true);
});
