// Task 1: SITE_BASE_URL for emailed links.
//   - set   -> verification + reset links use it
//   - unset -> EXACTLY the old behaviour (RAILWAY_PUBLIC_DOMAIN, else localhost)
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-helpers/harness');
const links = require('../lib/links');

before(h.start);
after(h.stop);
beforeEach(() => {
  h.resetState();
  delete process.env.SITE_BASE_URL;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
});

// ---- pure function: every combination of the two env vars ----

test('unset SITE_BASE_URL + Railway domain -> the old https://<railway domain> base', () => {
  const env = { RAILWAY_PUBLIC_DOMAIN: 'ahead-backend-production-ee80.up.railway.app' };
  assert.equal(links.emailLinkBase(env), 'https://ahead-backend-production-ee80.up.railway.app');
  assert.equal(links.resetPasswordLink('tok', env), 'https://ahead-backend-production-ee80.up.railway.app/reset-password.html?token=tok');
  assert.equal(links.verifyEmailLink('tok', env), 'https://ahead-backend-production-ee80.up.railway.app/verify-email.html?token=tok');
});

test('unset SITE_BASE_URL + no Railway domain -> the old http://localhost:3000 fallback', () => {
  assert.equal(links.emailLinkBase({}), 'http://localhost:3000');
  assert.equal(links.resetPasswordLink('tok', {}), 'http://localhost:3000/reset-password.html?token=tok');
});

test('SITE_BASE_URL wins over the Railway domain', () => {
  const env = { SITE_BASE_URL: 'https://aheadt1d.com', RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' };
  assert.equal(links.resetPasswordLink('tok', env), 'https://aheadt1d.com/reset-password.html?token=tok');
  assert.equal(links.verifyEmailLink('tok', env), 'https://aheadt1d.com/verify-email.html?token=tok');
});

test('SITE_BASE_URL is trimmed and a trailing slash is dropped', () => {
  assert.equal(links.emailLinkBase({ SITE_BASE_URL: '  https://aheadt1d.com/  ' }), 'https://aheadt1d.com');
  assert.equal(links.emailLinkBase({ SITE_BASE_URL: 'https://aheadt1d.com///' }), 'https://aheadt1d.com');
});

test('blank or unusable SITE_BASE_URL falls back to the old behaviour instead of emailing a broken link', () => {
  const railway = { RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' };
  assert.equal(links.emailLinkBase({ ...railway, SITE_BASE_URL: '' }), 'https://x.up.railway.app');
  assert.equal(links.emailLinkBase({ ...railway, SITE_BASE_URL: '   ' }), 'https://x.up.railway.app');
  // no scheme would become a relative link in an email
  assert.equal(links.emailLinkBase({ ...railway, SITE_BASE_URL: 'aheadt1d.com' }), 'https://x.up.railway.app');
});

// ---- through the real routes ----

test('password-reset request emails a link on SITE_BASE_URL when it is set', async () => {
  process.env.SITE_BASE_URL = 'https://aheadt1d.com';
  h.fake.addUser({ email: 'a@example.com' });
  const res = await h.http('POST', '/api/auth/password-reset/request', { body: { email: 'a@example.com' } });
  assert.equal(res.status, 200);
  assert.equal(h.mailer.sent.length, 1);
  assert.equal(h.mailer.sent[0].kind, 'reset');
  assert.match(h.mailer.sent[0].url, /^https:\/\/aheadt1d\.com\/reset-password\.html\?token=ahead_et_[A-Za-z0-9_-]+$/);
});

test('password-reset request keeps the Railway-hostname link when SITE_BASE_URL is unset', async () => {
  process.env.RAILWAY_PUBLIC_DOMAIN = 'ahead-backend-production-ee80.up.railway.app';
  h.fake.addUser({ email: 'a@example.com' });
  await h.http('POST', '/api/auth/password-reset/request', { body: { email: 'a@example.com' } });
  assert.match(h.mailer.sent[0].url, /^https:\/\/ahead-backend-production-ee80\.up\.railway\.app\/reset-password\.html\?token=ahead_et_/);
});

test('password-reset request falls back to localhost with neither variable set', async () => {
  h.fake.addUser({ email: 'a@example.com' });
  await h.http('POST', '/api/auth/password-reset/request', { body: { email: 'a@example.com' } });
  assert.match(h.mailer.sent[0].url, /^http:\/\/localhost:3000\/reset-password\.html\?token=ahead_et_/);
});

test('verify-email resend uses SITE_BASE_URL when set, Railway hostname when not', async () => {
  const user = h.fake.addUser({ email: 'b@example.com', verified: false });

  process.env.SITE_BASE_URL = 'https://aheadt1d.com';
  let res = await h.http('POST', '/api/auth/verify-email/resend', { headers: h.bearer(user) });
  assert.equal(res.status, 200);
  assert.match(h.mailer.sent[0].url, /^https:\/\/aheadt1d\.com\/verify-email\.html\?token=ahead_et_/);

  delete process.env.SITE_BASE_URL;
  process.env.RAILWAY_PUBLIC_DOMAIN = 'x.up.railway.app';
  res = await h.http('POST', '/api/auth/verify-email/resend', { headers: h.bearer(user) });
  assert.equal(res.status, 200);
  assert.match(h.mailer.sent[1].url, /^https:\/\/x\.up\.railway\.app\/verify-email\.html\?token=ahead_et_/);
});

test('signup verification email (fire-and-forget) uses SITE_BASE_URL when set', async () => {
  process.env.SITE_BASE_URL = 'https://aheadt1d.com';
  const res = await h.http('POST', '/api/auth/signup', { body: { email: 'new@example.com', password: 'a-long-enough-password' } });
  assert.equal(res.status, 201);
  // The email goes out AFTER the response; give the background promise a moment.
  for (let i = 0; i < 50 && h.mailer.sent.length === 0; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(h.mailer.sent.length, 1);
  assert.equal(h.mailer.sent[0].kind, 'verify');
  assert.match(h.mailer.sent[0].url, /^https:\/\/aheadt1d\.com\/verify-email\.html\?token=ahead_et_/);
});

test('signup verification email keeps the Railway-hostname link when SITE_BASE_URL is unset', async () => {
  process.env.RAILWAY_PUBLIC_DOMAIN = 'x.up.railway.app';
  const res = await h.http('POST', '/api/auth/signup', { body: { email: 'new2@example.com', password: 'a-long-enough-password' } });
  assert.equal(res.status, 201);
  for (let i = 0; i < 50 && h.mailer.sent.length === 0; i++) await new Promise(r => setTimeout(r, 20));
  assert.match(h.mailer.sent[0].url, /^https:\/\/x\.up\.railway\.app\/verify-email\.html\?token=ahead_et_/);
});
