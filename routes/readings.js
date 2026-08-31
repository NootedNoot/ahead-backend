const express = require('express');
const db = require('../db');
const { requireUser } = require('../auth');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

// Lenient about version/variant bits on purpose - this only needs to catch
// obviously-malformed input before it reaches a UUID-typed column, not
// assert RFC 4122 strictness.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The companion-app read path. ownerId defaults to the caller's own id;
// reading anyone else's requires an active `shares` row granting it - the
// core authorization check for the whole sharing model.
router.get('/', requireUser, asyncHandler(async (req, res) => {
  const ownerId = req.query.ownerId || req.user.id;
  // Found live 2026-08-31 via adversarial testing: a garbage non-UUID
  // ownerId (e.g. "not-a-real-uuid-at-all") previously reached the `shares`/
  // `readings` queries directly and hit an unhandled Postgres
  // invalid-input-syntax-for-type-uuid error - a client typo shouldn't ever
  // 500 the server.
  if (!UUID_PATTERN.test(ownerId)) {
    return res.status(400).json({ error: 'ownerId must be a valid UUID' });
  }
  const count = Math.min(parseInt(req.query.count, 10) || 100, 500);

  if (ownerId !== req.user.id) {
    const { rows } = await db.query(
      'SELECT 1 FROM shares WHERE owner_id = $1 AND viewer_id = $2',
      [ownerId, req.user.id],
    );
    if (rows.length === 0) return res.status(403).json({ error: "You don't have access to this data stream" });
  }

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

module.exports = router;
