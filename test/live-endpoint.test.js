const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-helpers/harness');

before(h.start);
after(h.stop);
beforeEach(h.resetState);

// 2026-10-02: /api/readings/live used to return the owner's (or the first
// user's) live glucose + email to any unauthenticated caller, including
// everyone reaching it through the public Cloudflare tunnel.

function seedOwner() {
  const owner = h.fake.addUser({ email: 'owner@aheadt1d.com' });
  owner.is_owner = true;
  h.fake.addReading(owner.id, Date.now(), 123);
  return owner;
}

test('live: unauthenticated request through the tunnel is refused', async () => {
  seedOwner();
  for (const headers of [{ 'Cf-Connecting-Ip': '203.0.113.9' }, { 'X-Forwarded-For': '203.0.113.9' }, { 'Cf-Ray': 'abc' }]) {
    const res = await h.http('GET', '/api/readings/live', { headers });
    assert.equal(res.status, 401, JSON.stringify(headers));
    assert.equal(res.json.latest, undefined);
    assert.equal(res.json.user, undefined);
  }
});

test('live: unauthenticated never falls back to "first user ever created"', async () => {
  h.fake.addUser({ email: 'someone@example.com' }); // not an owner
  const res = await h.http('GET', '/api/readings/live', { headers: { 'X-Forwarded-For': '198.51.100.1' } });
  assert.equal(res.status, 401);
});

test('live: a genuine local request with no proxy headers still gets the owner stream', async () => {
  const owner = seedOwner();
  // h.http always adds X-Forwarded-For, so call the server directly with no
  // proxy headers - exactly what the local desktop client sends.
  const res = await h.rawGet('/api/readings/live');
  assert.equal(res.status, 200);
  assert.equal(res.json.user.id, owner.id);
  assert.equal(res.json.latest.sgv, 123);
});

test('live: a signed-in user gets their own stream even through the tunnel', async () => {
  seedOwner();
  const me = h.fake.addUser({ email: 'me@example.com' });
  h.fake.addReading(me.id, Date.now(), 150);
  const res = await h.http('GET', '/api/readings/live', { headers: { ...h.bearer(me), 'Cf-Connecting-Ip': '203.0.113.9' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.id, me.id);
  assert.equal(res.json.latest.sgv, 150);
});
