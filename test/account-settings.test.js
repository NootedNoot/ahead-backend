const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-helpers/harness');

before(h.start);
after(h.stop);
beforeEach(h.resetState);

test('Account Settings: GET /api/auth/me returns profile and clinical preferences', async () => {
  const user = h.fake.addUser({ email: 'patient@example.com' });
  user.display_name = 'Jane Doe';
  user.dob = '1995-06-15';
  user.diagnosis_date = '2010-04-20';
  user.target_low = 75;
  user.target_high = 170;
  user.units = 'mg/dL';

  const res = await h.http('GET', '/api/auth/me', { headers: h.bearer(user) });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.email, 'patient@example.com');
  assert.equal(res.json.user.displayName, 'Jane Doe');
  assert.equal(res.json.user.dob, '1995-06-15');
  assert.equal(res.json.user.diagnosisDate, '2010-04-20');
  assert.equal(res.json.user.targetLow, 75);
  assert.equal(res.json.user.targetHigh, 170);
  assert.equal(res.json.user.units, 'mg/dL');
});

test('Account Settings: PATCH /api/auth/profile updates profile and clinical preferences', async () => {
  const user = h.fake.addUser({ email: 'user2@example.com' });
  user.display_name = 'Original Name';

  const res = await h.http('PATCH', '/api/auth/profile', {
    headers: h.bearer(user),
    body: {
      displayName: 'Updated Name',
      dob: '1990-01-01',
      diagnosisDate: '2005-05-05',
      targetLow: 80,
      targetHigh: 160,
      units: 'mmol/L',
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.equal(res.json.user.displayName, 'Updated Name');
  assert.equal(res.json.user.dob, '1990-01-01');
  assert.equal(res.json.user.diagnosisDate, '2005-05-05');
  assert.equal(res.json.user.targetLow, 80);
  assert.equal(res.json.user.targetHigh, 160);
  assert.equal(res.json.user.units, 'mmol/L');

  // Verify in-memory state
  const found = h.fake.users.find(x => x.id === user.id);
  assert.equal(found.display_name, 'Updated Name');
  assert.equal(found.dob, '1990-01-01');
  assert.equal(found.target_low, 80);
  assert.equal(found.units, 'mmol/L');
});

test('Account Settings: PATCH /api/auth/profile validates input limits', async () => {
  const user = h.fake.addUser({ email: 'user3@example.com' });

  // Target low too small (< 40)
  const r1 = await h.http('PATCH', '/api/auth/profile', {
    headers: h.bearer(user),
    body: { targetLow: 30 },
  });
  assert.equal(r1.status, 400);
  assert.match(r1.json.error, /Target low must be between/i);

  // Invalid units
  const r2 = await h.http('PATCH', '/api/auth/profile', {
    headers: h.bearer(user),
    body: { units: 'invalid_unit' },
  });
  assert.equal(r2.status, 400);
  assert.match(r2.json.error, /Units must be either/i);

  // Empty body
  const r3 = await h.http('PATCH', '/api/auth/profile', {
    headers: h.bearer(user),
    body: {},
  });
  assert.equal(r3.status, 400);
  assert.match(r3.json.error, /No valid profile fields provided/i);
});

test('Account Settings: POST /api/auth/change-email updates email and requires valid password', async () => {
  const user = h.fake.addUser({ email: 'old@example.com' });
  user.password_hash = await h.auth.hashPassword('CurrentSecret123!');

  // Wrong password
  const r1 = await h.http('POST', '/api/auth/change-email', {
    headers: h.bearer(user),
    body: { newEmail: 'brandnew@example.com', currentPassword: 'WrongPassword' },
  });
  assert.equal(r1.status, 401);
  assert.match(r1.json.error, /Incorrect password/i);

  // Successful change
  const r2 = await h.http('POST', '/api/auth/change-email', {
    headers: h.bearer(user),
    body: { newEmail: 'brandnew@example.com', currentPassword: 'CurrentSecret123!' },
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.success, true);
  assert.equal(r2.json.user.email, 'brandnew@example.com');
  assert.equal(r2.json.user.emailVerified, false);
  assert.ok(r2.json.token);

  const found = h.fake.users.find(x => x.id === user.id);
  assert.equal(found.email, 'brandnew@example.com');
  assert.equal(found.email_verified_at, null);
});

test('Account Settings: DELETE /api/auth/account prohibits deleting owner account', async () => {
  const owner = h.fake.addUser({ email: 'owner@example.com' });
  owner.password_hash = await h.auth.hashPassword('OwnerSecret123!');
  owner.is_owner = true;

  const res = await h.http('DELETE', '/api/auth/account', {
    headers: h.bearer(owner),
    body: { password: 'OwnerSecret123!' },
  });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /Owner account cannot be deleted/i);
  assert.ok(h.fake.users.find(x => x.id === owner.id), 'Owner was not deleted');
});
