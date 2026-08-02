// Run with: npm test (node --test)
// AHEAD_API_KEY is deliberately left UNSET here (opposite of
// server-auth.test.js) to cover requireApiKey's fail-closed behavior: a
// misconfigured deployment must refuse all protected traffic, not silently
// accept every caller.

delete process.env.AHEAD_API_KEY;

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server.js');

test('protected routes fail closed with 500 when AHEAD_API_KEY is not configured', async () => {
  const res = await request(app)
    .get('/api/latest-trend')
    .set('X-Ahead-Api-Key', 'anything-at-all')
    .set('X-Ahead-Device-Id', 'device-1');
  assert.equal(res.status, 500);
  assert.match(res.body.error, /misconfigured/i);
});

test('check-trend also fails closed with 500 when AHEAD_API_KEY is not configured', async () => {
  const res = await request(app)
    .post('/api/check-trend')
    .set('X-Ahead-Api-Key', 'anything-at-all')
    .set('X-Ahead-Device-Id', 'device-1')
    .send({ readings: [{ sgv: 120, date: Date.now() - 300000 }, { sgv: 130, date: Date.now() }] });
  assert.equal(res.status, 500);
});

test('the public health check still works with no key configured', async () => {
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
});
