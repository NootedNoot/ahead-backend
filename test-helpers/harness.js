// Shared test harness: boots the real Express app in-process against a
// FakeDb, with dummy secrets, and with every outbound side effect (email,
// database) replaced. Require this FIRST in a test file, before anything
// else from the app - it sets the environment the app reads at load time.
//
// Safety properties (on purpose, because a test run must never be able to
// reach production):
//   - DATABASE_URL / PG* vars are removed and db.query is replaced, so no
//     query can leave the process.
//   - RESEND_API_KEY is removed and the email senders are replaced with
//     recorders, so no email can be sent.
//   - Secrets below are obvious dummies used only inside the test process.
const crypto = require('crypto');

for (const name of ['DATABASE_URL', 'PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT',
  'RESEND_API_KEY', 'SITE_BASE_URL', 'RAILWAY_PUBLIC_DOMAIN']) {
  delete process.env[name];
}
process.env.JWT_SECRET = 'test-only-jwt-secret-not-real';
process.env.ADMIN_JWT_SECRET = 'test-only-admin-jwt-secret-not-real';
process.env.DEVICE_KEY_PEPPER = 'test-only-device-pepper-not-real';
process.env.EMAIL_TOKEN_PEPPER = 'test-only-email-pepper-not-real';

const { FakeDb } = require('./fake-db');

const realDb = require('../db');
const fake = new FakeDb();
realDb.query = (text, params) => fake.query(text, params);
realDb.transaction = fn => fake.transaction(fn);

// Email recorders. auth-routes destructures these at require time, so they
// must be swapped in BEFORE the app is required below.
const email = require('../lib/email');
const mailer = {
  sent: [],            // { kind, to, url? }
  failWith: null,      // set to an Error to make every send reject
  reset() { this.sent = []; this.failWith = null; },
};
function recorder(kind) {
  return async (to, url) => {
    if (mailer.failWith) throw mailer.failWith;
    mailer.sent.push({ kind, to, url });
  };
}
email.sendPasswordResetEmail = recorder('reset');
email.sendVerificationEmail = recorder('verify');
email.sendPasswordChangedEmail = recorder('changed');

const auth = require('../auth');
const app = require('../server');

let server;
let baseUrl;
let ipCounter = 0;

async function start() {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stop() {
  await new Promise(resolve => server.close(resolve));
}

// Every request gets its own fake client IP so the per-IP auth rate limiter
// (10/min on /api/auth) never interferes with a test.
async function http(method, path, { headers = {}, body } = {}) {
  ipCounter += 1;
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      'X-Forwarded-For': `10.${(ipCounter >> 8) & 255}.${ipCounter & 255}.1`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
}

function bearer(user) {
  return { Authorization: `Bearer ${auth.signUserToken(user)}` };
}

// A key row in the fake DB, stored exactly the way the real code stores it
// (HMAC hash of the raw key). Returns the raw key.
function addKey(user, { role = 'uploader', revoked = false, generator } = {}) {
  const gen = generator || (role === 'viewer' ? auth.generateViewerKey : auth.generateDeviceKey);
  const { raw, hash, prefix } = gen();
  const row = fake.addDeviceKeyRow({ userId: user.id, hash, prefix, role, revoked });
  return { raw, row };
}

// Fresh isolated state for each test.
function resetState() {
  fake.users = []; fake.deviceKeys = []; fake.shares = []; fake.readings = [];
  fake.emailTokens = []; fake.authEvents = []; fake.log = [];
  fake.missingRoleColumn = false; fake.failOn = null;
  mailer.reset();
}

module.exports = { fake, mailer, auth, start, stop, http, bearer, addKey, resetState, crypto };
