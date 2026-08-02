// Run with: npm test (node --test)
// Exercises server.js's routes with a valid AHEAD_API_KEY set - the "normal
// operation" auth/validation paths. See server-no-key.test.js for the
// fail-closed (unset key) case - that has to live in its own file/process
// since AHEAD_API_KEY is read into a module-level const at require time.

process.env.AHEAD_API_KEY = 'test-key-123';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../server.js');

test('GET / is a public health check, no key required', async () => {
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /Ahead backend is running/);
});

test('missing API key is rejected with 401', async () => {
  const res = await request(app)
    .get('/api/latest-trend')
    .set('X-Ahead-Device-Id', 'device-1');
  assert.equal(res.status, 401);
});

test('wrong API key is rejected with 401', async () => {
  const res = await request(app)
    .get('/api/latest-trend')
    .set('X-Ahead-Api-Key', 'not-the-right-key')
    .set('X-Ahead-Device-Id', 'device-1');
  assert.equal(res.status, 401);
});

test('valid key but missing X-Ahead-Device-Id is rejected with 400', async () => {
  const res = await request(app)
    .get('/api/latest-trend')
    .set('X-Ahead-Api-Key', 'test-key-123');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /X-Ahead-Device-Id/);
});

test('valid key + device id but no trend recorded yet is a 404', async () => {
  const res = await request(app)
    .get('/api/latest-trend')
    .set('X-Ahead-Api-Key', 'test-key-123')
    .set('X-Ahead-Device-Id', `device-${Date.now()}`); // fresh device id - never seen before
  assert.equal(res.status, 404);
});

test('check-trend rejects fewer than 2 readings', async () => {
  const res = await request(app)
    .post('/api/check-trend')
    .set('X-Ahead-Api-Key', 'test-key-123')
    .set('X-Ahead-Device-Id', 'device-1')
    .send({ readings: [{ sgv: 120, date: Date.now() }] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /insufficient/i);
});

test('check-trend rejects a non-array readings field', async () => {
  const res = await request(app)
    .post('/api/check-trend')
    .set('X-Ahead-Api-Key', 'test-key-123')
    .set('X-Ahead-Device-Id', 'device-1')
    .send({ readings: 'not-an-array' });
  assert.equal(res.status, 400);
});

test('check-trend rejects when X-Ahead-Device-Id is missing, even with a valid key', async () => {
  const res = await request(app)
    .post('/api/check-trend')
    .set('X-Ahead-Api-Key', 'test-key-123')
    .send({ readings: [{ sgv: 120, date: Date.now() - 300000 }, { sgv: 130, date: Date.now() }] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /X-Ahead-Device-Id/);
});

test('check-trend with valid input processes and returns a result, then latest-trend reflects it', async () => {
  const deviceId = `device-${Date.now()}-flow`;
  const now = Date.now();
  const checkRes = await request(app)
    .post('/api/check-trend')
    .set('X-Ahead-Api-Key', 'test-key-123')
    .set('X-Ahead-Device-Id', deviceId)
    .send({
      readings: [
        { sgv: 120, date: now - 5 * 60000 },
        { sgv: 118, date: now },
      ],
    });
  assert.equal(checkRes.status, 200);
  assert.equal(checkRes.body.processed.length, 1);

  const trendRes = await request(app)
    .get('/api/latest-trend')
    .set('X-Ahead-Api-Key', 'test-key-123')
    .set('X-Ahead-Device-Id', deviceId);
  assert.equal(trendRes.status, 200);
  assert.equal(trendRes.body.currentValue, 118);
});

test('protected routes carry rate-limit headers', async () => {
  const res = await request(app)
    .get('/api/latest-trend')
    .set('X-Ahead-Api-Key', 'test-key-123')
    .set('X-Ahead-Device-Id', 'device-ratelimit-check');
  assert.ok(res.headers['ratelimit-limit'] !== undefined, 'expected a RateLimit-Limit header on a rate-limited route');
});
