const express = require('express');
const db = require('../db');
const { requireUser, requireDeviceKey, requireUserOrViewerKey } = require('../auth');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

const requireDeviceOrUser = asyncHandler(async (req, res, next) => {
  if (req.get('X-Ahead-Api-Key')) {
    return requireDeviceKey(req, res, next);
  }
  return requireUser(req, res, next);
});

// Lenient about version/variant bits on purpose - this only needs to catch
// obviously-malformed input before it reaches a UUID-typed column, not
// assert RFC 4122 strictness.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveOwner(req, res) {
  const ownerId = req.query.ownerId || req.user.id;
  if (!UUID_PATTERN.test(ownerId)) {
    res.status(400).json({ error: 'ownerId must be a valid UUID' });
    return null;
  }
  if (ownerId !== req.user.id) {
    const { rows } = await db.query(
      'SELECT 1 FROM shares WHERE owner_id = $1 AND viewer_id = $2',
      [ownerId, req.user.id],
    );
    if (rows.length === 0) {
      res.status(403).json({ error: "You don't have access to this data stream" });
      return null;
    }
  }
  return ownerId;
}

// The companion-app read path. ownerId defaults to the caller's own id;
// reading anyone else's requires an active `shares` row granting it - the
// core authorization check for the whole sharing model.
router.get('/', requireUserOrViewerKey, asyncHandler(async (req, res) => {
  const ownerId = await resolveOwner(req, res);
  if (!ownerId) return;
  const count = Math.min(parseInt(req.query.count, 10) || 100, 500);

  const { rows } = await db.query(
    `SELECT sgv, reading_time_ms FROM readings
     WHERE user_id = $1 ORDER BY reading_time_ms DESC LIMIT $2`,
    [ownerId, count],
  );
  // Ascending, matching the shape ahead-lite-android's old Nightscout
  // client already sorted into - {sgv, date} per entry, oldest first.
  const entries = rows.reverse().map(r => ({ sgv: r.sgv, date: Number(r.reading_time_ms) }));
  res.json({ entries });
}));

// GET /api/readings/stats
// Clinical 14-day (or customizable) aggregate snapshot: TIR, GMI, SD, CV, and 24h AGP
router.get('/stats', requireUserOrViewerKey, asyncHandler(async (req, res) => {
  const ownerId = await resolveOwner(req, res);
  if (!ownerId) return;

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90);
  const tzOffsetMin = parseInt(req.query.tzOffsetMin, 10) || 0;
  const sinceMs = Date.now() - (days * 24 * 60 * 60 * 1000);

  const { rows } = await db.query(
    `SELECT sgv, reading_time_ms FROM readings
     WHERE user_id = $1 AND reading_time_ms >= $2
     ORDER BY reading_time_ms ASC`,
    [ownerId, sinceMs],
  );

  const total = rows.length;
  if (total === 0) {
    return res.json({
      days,
      totalReadings: 0,
      activePercent: 0,
      metrics: null,
      tir: null,
      hourlyAgp: [],
    });
  }

  let sum = 0;
  let min = rows[0].sgv;
  let max = rows[0].sgv;
  let veryLow = 0;
  let low = 0;
  let inRange = 0;
  let high = 0;
  let veryHigh = 0;

  const hourlyBuckets = Array.from({ length: 24 }, () => []);

  for (const r of rows) {
    const v = r.sgv;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;

    if (v < 54) veryLow++;
    else if (v < 70) low++;
    else if (v <= 180) inRange++;
    else if (v <= 250) high++;
    else veryHigh++;

    const readingTime = Number(r.reading_time_ms);
    const localMs = readingTime - (tzOffsetMin * 60000);
    const hour = new Date(localMs).getUTCHours();
    if (hour >= 0 && hour < 24) {
      hourlyBuckets[hour].push(v);
    }
  }

  const mean = Math.round((sum / total) * 10) / 10;
  let varianceSum = 0;
  for (const r of rows) {
    varianceSum += Math.pow(r.sgv - mean, 2);
  }
  const stdDev = Math.round(Math.sqrt(varianceSum / total) * 10) / 10;
  const cv = mean > 0 ? Math.round((stdDev / mean) * 1000) / 10 : 0;
  const gmi = Math.round((3.31 + (0.02392 * mean)) * 10) / 10;
  const expectedReadings = days * 288;
  const activePercent = Math.min(100, Math.round((total / expectedReadings) * 1000) / 10);

  const pct = (cnt) => Math.round((cnt / total) * 1000) / 10;

  const hourlyAgp = hourlyBuckets.map((bucket, hour) => {
    if (bucket.length === 0) return { hour, count: 0, median: null, p25: null, p75: null };
    bucket.sort((a, b) => a - b);
    const p = (q) => bucket[Math.floor(q * (bucket.length - 1))];
    return {
      hour,
      count: bucket.length,
      median: p(0.5),
      p25: p(0.25),
      p75: p(0.75),
    };
  });

  res.json({
    days,
    totalReadings: total,
    activePercent,
    metrics: {
      mean,
      stdDev,
      cv,
      gmi,
      min,
      max,
    },
    tir: {
      veryLow: { count: veryLow, percent: pct(veryLow) },
      low: { count: low, percent: pct(low) },
      inRange: { count: inRange, percent: pct(inRange) },
      high: { count: high, percent: pct(high) },
      veryHigh: { count: veryHigh, percent: pct(veryHigh) },
    },
    hourlyAgp,
  });
}));

// GET /api/readings/export
// Doctor/Endocrinologist CSV download
router.get('/export', requireUserOrViewerKey, asyncHandler(async (req, res) => {
  const ownerId = await resolveOwner(req, res);
  if (!ownerId) return;

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90);
  const sinceMs = Date.now() - (days * 24 * 60 * 60 * 1000);

  const { rows } = await db.query(
    `SELECT sgv, reading_time_ms FROM readings
     WHERE user_id = $1 AND reading_time_ms >= $2
     ORDER BY reading_time_ms ASC`,
    [ownerId, sinceMs],
  );

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ahead-glucose-${days}days.csv"`);

  let csv = 'Timestamp (UTC),Local Time,Glucose (mg/dL)\r\n';
  for (const r of rows) {
    const t = Number(r.reading_time_ms);
    const d = new Date(t);
    const iso = d.toISOString();
    const local = iso.replace('T', ' ').slice(0, 19);
    csv += `"${iso}","${local}",${r.sgv}\r\n`;
  }
  res.send(csv);
}));

// DELETE /api/readings
// Allows clearing recent/injected readings for testing and reset
router.delete('/', requireDeviceOrUser, asyncHandler(async (req, res) => {
  const userId = req.userId || req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  const since = req.query.since ? parseInt(req.query.since, 10) : null;
  if (since && Number.isFinite(since)) {
    await db.query('DELETE FROM readings WHERE user_id = $1 AND reading_time_ms >= $2', [userId, since]);
  } else if (req.query.all === 'true') {
    await db.query('DELETE FROM readings WHERE user_id = $1', [userId]);
  } else {
    // Default: delete readings from last 2 hours (cleans up any recent test session)
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    await db.query('DELETE FROM readings WHERE user_id = $1 AND reading_time_ms >= $2', [userId, twoHoursAgo]);
  }
  res.json({ success: true, message: 'Readings cleared' });
}));

// POST /api/readings/action
// Records the phone's decision/action taken for a specific reading (e.g. audible_red, silent_yellow, held_high_red, suppressed_cooldown)
router.post('/action', requireDeviceOrUser, asyncHandler(async (req, res) => {
  const userId = req.userId || req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });

  const { readingTime, action } = req.body || {};
  if (!readingTime || !action || typeof action !== 'string') {
    return res.status(400).json({ error: 'readingTime and action string required' });
  }

  await db.query(
    `UPDATE readings SET action = $1
     WHERE user_id = $2 AND reading_time_ms = $3`,
    [action, userId, Number(readingTime)]
  );

  res.json({ success: true, readingTime, action });
}));

module.exports = router;
