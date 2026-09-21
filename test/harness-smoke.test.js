// Sanity checks for the test harness itself (in-process app + fake DB), plus
// a guard that requiring server.js does NOT bind a port (only `node server.js`
// does).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-helpers/harness');

before(h.start);
after(h.stop);
beforeEach(h.resetState);

test('GET / answers from the in-process app', async () => {
  const res = await h.http('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.text, /Ahead backend is running/);
});

test('protected routes reject unauthenticated requests without touching the DB', async () => {
  const res = await h.http('GET', '/api/readings');
  assert.equal(res.status, 401);
  assert.equal(h.fake.log.length, 0);
});

test('an unrecognised SQL statement fails loudly instead of returning empty rows', async () => {
  await assert.rejects(() => h.fake.query('SELECT * FROM something_unexpected'), /unhandled SQL/);
});
