// User-logged events (notes/tags against the glucose timeline) - synced
// between the phone app (ahead-android's Room `user_events` table), the web
// portal, and the doctor report.
//
// Sync model: every event has a client-chosen `clientId` (unique per user),
// and the server is the meeting point. Writes are last-write-wins on the
// client's `updatedAt`, so a stale device can't clobber a newer edit made
// elsewhere. Every server-side write bumps `rev` from one sequence, and a
// device pulls "everything with rev > my cursor" - a monotonic counter, not
// a timestamp, so two writes in the same millisecond can never be skipped.
// Deletes are tombstones (deleted = true, note wiped) so other devices learn
// about them; the row itself goes away with the account (ON DELETE CASCADE).
//
// Events are owner-only on purpose: notes can be personal ("fight with mom",
// "skipped bolus"), so sharing glucose with a caregiver does NOT share notes.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireUser, requireDeviceKey } = require('../auth');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

// Same tag values the Android app stores (EventTag.storageValue). Unknown
// tags from a newer app version are kept as long as they look like a tag,
// so an older server never throws away data.
const KNOWN_TAGS = ['meal', 'insulin', 'correction', 'exercise', 'stress', 'illness', 'site_change', 'pod_issue', 'other'];
const TAG_PATTERN = /^[a-z_]{1,32}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
const MAX_NOTE = 2000;
const MAX_BATCH = 500;
const PULL_LIMIT = 1000;
// 2015-01-01 .. a day from now: rejects zero/garbage/seconds-not-ms times.
const MIN_TIME = Date.UTC(2015, 0, 1);

const requireDeviceOrUser = asyncHandler(async (req, res, next) => {
  if (req.get('X-Ahead-Api-Key')) {
    return requireDeviceKey(req, res, () => {
      req.user = { id: req.userId };
      next();
    });
  }
  return requireUser(req, res, next);
});

function cleanNote(note) {
  if (note === null || note === undefined) return null;
  const s = String(note).trim();
  return s ? s.slice(0, MAX_NOTE) : null;
}

function validTime(t) {
  return Number.isFinite(t) && t >= MIN_TIME && t <= Date.now() + 24 * 3600 * 1000;
}

function toApi(row) {
  return {
    clientId: row.client_id,
    time: Number(row.event_time_ms),
    tag: row.tag,
    note: row.note,
    glucoseAtTime: row.glucose_at_time !== null && row.glucose_at_time !== undefined ? Number(row.glucose_at_time) : null,
    updatedAt: Number(row.client_updated_ms),
    deleted: !!row.deleted,
    source: row.source,
    rev: Number(row.rev),
  };
}

const UPSERT_SQL = `
  INSERT INTO user_events (user_id, client_id, event_time_ms, tag, note, glucose_at_time, client_updated_ms, deleted, source, rev)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, nextval('user_events_rev_seq'))
  ON CONFLICT (user_id, client_id) DO UPDATE SET
    event_time_ms = EXCLUDED.event_time_ms, tag = EXCLUDED.tag, note = EXCLUDED.note,
    glucose_at_time = EXCLUDED.glucose_at_time, client_updated_ms = EXCLUDED.client_updated_ms,
    deleted = EXCLUDED.deleted, rev = nextval('user_events_rev_seq')
  WHERE user_events.client_updated_ms <= EXCLUDED.client_updated_ms
  RETURNING client_id`;

const SELECT_COLS = 'client_id, event_time_ms, tag, note, glucose_at_time, client_updated_ms, deleted, source, rev';

// Glucose closest to an event's time (within 10 min) - so an event logged on
// the web still shows "what was I at" like one logged on the phone does.
async function nearestGlucose(userId, timeMs) {
  const { rows } = await db.query(
    `SELECT sgv FROM readings WHERE user_id = $1 AND reading_time_ms BETWEEN $2 AND $3
     ORDER BY ABS(reading_time_ms - $4) ASC LIMIT 1`,
    [userId, timeMs - 600000, timeMs + 600000, timeMs],
  );
  return rows.length ? rows[0].sgv : null;
}

// POST /api/events/sync
// Body: { since: <rev cursor or 0>, changes: [{clientId, time, tag, note, glucoseAtTime, updatedAt, deleted}] }
// Applies the changes (last-write-wins), then returns every event of this
// user with rev > since, plus the new cursor. Used by the phone app.
router.post('/sync', requireDeviceOrUser, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const body = req.body || {};
  const changes = Array.isArray(body.changes) ? body.changes : [];
  const since = Number.isFinite(Number(body.since)) && Number(body.since) > 0 ? Math.floor(Number(body.since)) : 0;
  if (changes.length > MAX_BATCH) {
    return res.status(400).json({ error: `At most ${MAX_BATCH} changes per sync` });
  }

  const rejected = [];
  for (const c of changes) {
    const clientId = typeof c.clientId === 'string' ? c.clientId : '';
    const time = Number(c.time);
    const updatedAt = Number(c.updatedAt);
    const tag = typeof c.tag === 'string' ? c.tag : '';
    if (!CLIENT_ID_PATTERN.test(clientId) || !validTime(time) || !Number.isFinite(updatedAt) || updatedAt <= 0 || !TAG_PATTERN.test(tag)) {
      rejected.push(clientId || null);
      continue;
    }
    const deleted = c.deleted === true;
    const glucose = Number(c.glucoseAtTime);
    await db.query(UPSERT_SQL, [
      userId, clientId, time, tag,
      deleted ? null : cleanNote(c.note),
      !deleted && Number.isFinite(glucose) && glucose > 0 && glucose < 1000 ? glucose : null,
      Math.floor(updatedAt), deleted, 'phone',
    ]);
  }

  const { rows } = await db.query(
    `SELECT ${SELECT_COLS} FROM user_events WHERE user_id = $1 AND rev > $2 ORDER BY rev ASC LIMIT $3`,
    [userId, since, PULL_LIMIT],
  );
  const events = rows.map(toApi);
  res.json({
    events,
    cursor: events.length ? events[events.length - 1].rev : since,
    hasMore: rows.length === PULL_LIMIT,
    rejected,
  });
}));

// GET /api/events?from=<ms>&to=<ms>  (portal + doctor report; owner only)
router.get('/', requireUser, asyncHandler(async (req, res) => {
  const num = v => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const to = num(req.query.to) ?? Date.now();
  const from = num(req.query.from) ?? to - 14 * 24 * 3600 * 1000;
  if (to - from > 366 * 24 * 3600 * 1000 || to < from) {
    return res.status(400).json({ error: 'Range must be between 0 and 366 days' });
  }
  const { rows } = await db.query(
    `SELECT ${SELECT_COLS} FROM user_events
     WHERE user_id = $1 AND deleted = false AND event_time_ms BETWEEN $2 AND $3
     ORDER BY event_time_ms ASC LIMIT 5000`,
    [req.user.id, from, to],
  );
  res.json({ events: rows.map(toApi) });
}));

function readEventInput(body, { partial }) {
  const out = {};
  if (!partial || body.time !== undefined) {
    const time = body.time === undefined ? Date.now() : Number(body.time);
    if (!validTime(time)) return { error: 'time must be a valid epoch-ms timestamp' };
    out.time = Math.floor(time);
  }
  if (!partial || body.tag !== undefined) {
    if (!KNOWN_TAGS.includes(body.tag)) return { error: `tag must be one of: ${KNOWN_TAGS.join(', ')}` };
    out.tag = body.tag;
  }
  if (!partial || body.note !== undefined) out.note = cleanNote(body.note);
  return { value: out };
}

// POST /api/events  {time?, tag, note?}  - log an event from the web portal.
router.post('/', requireUser, asyncHandler(async (req, res) => {
  const { value, error } = readEventInput(req.body || {}, { partial: false });
  if (error) return res.status(400).json({ error });
  const clientId = 'web-' + crypto.randomUUID();
  const glucose = await nearestGlucose(req.user.id, value.time);
  await db.query(UPSERT_SQL, [req.user.id, clientId, value.time, value.tag, value.note, glucose, Date.now(), false, 'web']);
  const { rows } = await db.query(
    `SELECT ${SELECT_COLS} FROM user_events WHERE user_id = $1 AND client_id = $2`,
    [req.user.id, clientId],
  );
  res.status(201).json({ event: toApi(rows[0]) });
}));

async function loadOwn(req, res) {
  const clientId = req.params.clientId;
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    res.status(400).json({ error: 'Invalid event id' });
    return null;
  }
  const { rows } = await db.query(
    `SELECT ${SELECT_COLS} FROM user_events WHERE user_id = $1 AND client_id = $2`,
    [req.user.id, clientId],
  );
  if (!rows.length || rows[0].deleted) {
    res.status(404).json({ error: 'Event not found' });
    return null;
  }
  return rows[0];
}

// PATCH /api/events/:clientId  {time?, tag?, note?}
router.patch('/:clientId', requireUser, asyncHandler(async (req, res) => {
  const row = await loadOwn(req, res);
  if (!row) return;
  const { value, error } = readEventInput(req.body || {}, { partial: true });
  if (error) return res.status(400).json({ error });
  const time = value.time !== undefined ? value.time : Number(row.event_time_ms);
  const glucose = value.time !== undefined ? await nearestGlucose(req.user.id, time) : row.glucose_at_time;
  await db.query(UPSERT_SQL, [
    req.user.id, row.client_id, time,
    value.tag !== undefined ? value.tag : row.tag,
    value.note !== undefined ? value.note : row.note,
    glucose, Math.max(Date.now(), Number(row.client_updated_ms) + 1), false, row.source,
  ]);
  const { rows } = await db.query(
    `SELECT ${SELECT_COLS} FROM user_events WHERE user_id = $1 AND client_id = $2`,
    [req.user.id, row.client_id],
  );
  res.json({ event: toApi(rows[0]) });
}));

// DELETE /api/events/:clientId  - tombstone so the phone deletes it too.
router.delete('/:clientId', requireUser, asyncHandler(async (req, res) => {
  const row = await loadOwn(req, res);
  if (!row) return;
  await db.query(UPSERT_SQL, [
    req.user.id, row.client_id, Number(row.event_time_ms), row.tag, null, null,
    Math.max(Date.now(), Number(row.client_updated_ms) + 1), true, row.source,
  ]);
  res.json({ ok: true });
}));

module.exports = router;
module.exports.KNOWN_TAGS = KNOWN_TAGS;
