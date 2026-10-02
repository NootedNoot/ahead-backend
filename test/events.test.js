const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../test-helpers/harness');

before(h.start);
after(h.stop);
beforeEach(h.resetState);

const T = Date.UTC(2026, 8, 30, 15, 0);
const ev = (o = {}) => ({ clientId: 'android-a-1', time: T, tag: 'correction', note: 'high after pizza night', glucoseAtTime: 245, updatedAt: 1000, ...o });

async function sync(headers, changes = [], since = 0) {
  return h.http('POST', '/api/events/sync', { headers, body: { since, changes } });
}

test('events: phone pushes with its device key, portal sees it', async () => {
  const user = h.fake.addUser({ email: 'ryan@example.com' });
  const key = h.addKey(user).raw;
  const res = await sync({ 'X-Ahead-Api-Key': key }, [ev()]);
  assert.equal(res.status, 200);
  assert.equal(res.json.events.length, 1);
  assert.equal(res.json.cursor, res.json.events[0].rev);
  assert.deepEqual(res.json.rejected, []);

  const list = await h.http('GET', `/api/events?from=${T - 1000}&to=${T + 1000}`, { headers: h.bearer(user) });
  assert.equal(list.status, 200);
  assert.equal(list.json.events.length, 1);
  assert.equal(list.json.events[0].note, 'high after pizza night');
  assert.equal(list.json.events[0].glucoseAtTime, 245);
  assert.equal(list.json.events[0].source, 'phone');
});

test('events: last write wins - an older edit cannot clobber a newer one', async () => {
  const user = h.fake.addUser({ email: 'a@example.com' });
  const key = h.addKey(user).raw;
  await sync({ 'X-Ahead-Api-Key': key }, [ev({ note: 'new', updatedAt: 2000 })]);
  await sync({ 'X-Ahead-Api-Key': key }, [ev({ note: 'stale', updatedAt: 1000 })]);
  const list = await h.http('GET', `/api/events?from=${T - 1}&to=${T + 1}`, { headers: h.bearer(user) });
  assert.equal(list.json.events[0].note, 'new');
});

test('events: pull only returns changes after the cursor, including web edits and deletes', async () => {
  const user = h.fake.addUser({ email: 'b@example.com' });
  const key = h.addKey(user).raw;
  const first = await sync({ 'X-Ahead-Api-Key': key }, [ev()]);
  const cursor = first.json.cursor;

  const quiet = await sync({ 'X-Ahead-Api-Key': key }, [], cursor);
  assert.equal(quiet.json.events.length, 0);
  assert.equal(quiet.json.cursor, cursor);

  const created = await h.http('POST', '/api/events', { headers: h.bearer(user), body: { time: T + 60000, tag: 'meal', note: 'tacos' } });
  assert.equal(created.status, 201);
  assert.match(created.json.event.clientId, /^web-/);
  await h.http('DELETE', '/api/events/android-a-1', { headers: h.bearer(user) });

  const pulled = await sync({ 'X-Ahead-Api-Key': key }, [], cursor);
  const byId = Object.fromEntries(pulled.json.events.map(e => [e.clientId, e]));
  assert.equal(byId[created.json.event.clientId].note, 'tacos');
  assert.equal(byId['android-a-1'].deleted, true);
  assert.equal(byId['android-a-1'].note, null, 'a deleted note is wiped, not kept');

  const list = await h.http('GET', `/api/events?from=${T - 1}&to=${T + 120000}`, { headers: h.bearer(user) });
  assert.deepEqual(list.json.events.map(e => e.tag), ['meal']);
});

test('events: web-logged event picks up the nearest glucose reading', async () => {
  const user = h.fake.addUser({ email: 'c@example.com' });
  h.fake.addReading(user.id, T - 240000, 180);
  h.fake.addReading(user.id, T + 60000, 190);
  h.fake.addReading(user.id, T + 900000, 250);
  const res = await h.http('POST', '/api/events', { headers: h.bearer(user), body: { time: T, tag: 'exercise' } });
  assert.equal(res.json.event.glucoseAtTime, 190);
});

test('events: users never see each other\'s events, and shares do NOT expose notes', async () => {
  const owner = h.fake.addUser({ email: 'owner@example.com' });
  const viewer = h.fake.addUser({ email: 'mom@example.com' });
  h.fake.addShare(owner.id, viewer.id);
  await sync({ 'X-Ahead-Api-Key': h.addKey(owner).raw }, [ev()]);

  const theirs = await h.http('GET', `/api/events?from=${T - 1}&to=${T + 1}&ownerId=${owner.id}`, { headers: h.bearer(viewer) });
  assert.equal(theirs.json.events.length, 0);
  const pull = await sync(h.bearer(viewer), [], 0);
  assert.equal(pull.json.events.length, 0);
  const del = await h.http('DELETE', '/api/events/android-a-1', { headers: h.bearer(viewer) });
  assert.equal(del.status, 404);
});

test('events: viewer keys cannot sync or read events', async () => {
  const owner = h.fake.addUser({ email: 'd@example.com' });
  const vk = h.addKey(owner, { role: 'viewer' }).raw;
  assert.equal((await sync({ 'X-Ahead-Api-Key': vk }, [])).status, 401);
  assert.equal((await h.http('GET', '/api/events', { headers: { 'X-Ahead-Viewer-Key': vk } })).status, 401);
});

test('events: junk input is rejected or clamped, never stored as-is', async () => {
  const user = h.fake.addUser({ email: 'e@example.com' });
  const key = h.addKey(user).raw;
  const res = await sync({ 'X-Ahead-Api-Key': key }, [
    ev({ clientId: 'bad id with spaces' }),
    ev({ clientId: 'x2', time: 1234 }),                 // seconds, not ms
    ev({ clientId: 'x3', tag: 'DROP TABLE' }),
    ev({ clientId: 'x4', note: 'n'.repeat(5000), glucoseAtTime: 99999 }),
    ev({ clientId: 'x5', tag: 'future_tag' }),            // unknown but well-formed: kept
  ]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.rejected, ['bad id with spaces', 'x2', 'x3']);
  const x4 = res.json.events.find(e => e.clientId === 'x4');
  assert.equal(x4.note.length, 2000);
  assert.equal(x4.glucoseAtTime, null);
  assert.ok(res.json.events.find(e => e.clientId === 'x5'));

  const tooMany = await sync({ 'X-Ahead-Api-Key': key }, Array.from({ length: 501 }, (_, i) => ev({ clientId: 'k' + i })));
  assert.equal(tooMany.status, 400);

  const badWeb = await h.http('POST', '/api/events', { headers: h.bearer(user), body: { tag: 'future_tag' } });
  assert.equal(badWeb.status, 400);
});

test('events: PATCH edits note/tag; moving the time refreshes glucose', async () => {
  const user = h.fake.addUser({ email: 'f@example.com' });
  h.fake.addReading(user.id, T + 3600000, 111);
  const created = await h.http('POST', '/api/events', { headers: h.bearer(user), body: { time: T, tag: 'other', note: 'x' } });
  const id = created.json.event.clientId;
  const res = await h.http('PATCH', `/api/events/${id}`, { headers: h.bearer(user), body: { tag: 'illness', note: 'flu', time: T + 3600000 } });
  assert.equal(res.status, 200);
  assert.equal(res.json.event.tag, 'illness');
  assert.equal(res.json.event.note, 'flu');
  assert.equal(res.json.event.glucoseAtTime, 111);
  assert.ok(res.json.event.updatedAt > created.json.event.updatedAt);
});

test('events: deleting the account deletes its events', async () => {
  const user = h.fake.addUser({ email: 'g@example.com' });
  await sync({ 'X-Ahead-Api-Key': h.addKey(user).raw }, [ev()]);
  assert.equal(h.fake.userEvents.length, 1);
  await h.fake.query('DELETE FROM users WHERE id = $1', [user.id]);
  assert.equal(h.fake.userEvents.length, 0);
});

test('readings/range: returns a window as parallel arrays, owner or sharee only', async () => {
  const owner = h.fake.addUser({ email: 'h@example.com' });
  const stranger = h.fake.addUser({ email: 'i@example.com' });
  for (let i = 0; i < 5; i++) h.fake.addReading(owner.id, T + i * 300000, 100 + i);
  const res = await h.http('GET', `/api/readings/range?from=${T + 300000}&to=${T + 900000}`, { headers: h.bearer(owner) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.v, [101, 102, 103]);
  assert.equal(res.json.t.length, 3);
  const denied = await h.http('GET', `/api/readings/range?ownerId=${owner.id}`, { headers: h.bearer(stranger) });
  assert.equal(denied.status, 403);
  const tooLong = await h.http('GET', `/api/readings/range?from=0&to=${T}`, { headers: h.bearer(owner) });
  assert.equal(tooLong.status, 400);
});
