const express = require('express');
const db = require('../db');
const { requireUser, generateDeviceKey } = require('../auth');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

// Mint a new device API key for the logged-in user. The raw key is
// returned exactly once, here - only its hash is ever stored. ahead-android
// calls this once, right after login/signup during setup, then stores the
// raw key locally for all its background uploads thereafter.
router.post('/', requireUser, asyncHandler(async (req, res) => {
  const { label } = req.body || {};
  const { raw, hash, prefix } = generateDeviceKey();

  const { rows } = await db.query(
    `INSERT INTO device_keys (user_id, key_hash, key_prefix, label)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [req.user.id, hash, prefix, label || null],
  );

  res.status(201).json({ deviceId: rows[0].id, apiKey: raw, label: label || null });
}));

router.get('/', requireUser, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, label, key_prefix, created_at, last_used_at, revoked_at
     FROM device_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.id],
  );
  res.json(rows.map(r => ({
    deviceId: r.id,
    label: r.label,
    keyPrefix: r.key_prefix,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revoked: r.revoked_at !== null,
  })));
}));

router.post('/:id/revoke', requireUser, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `UPDATE device_keys SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [req.params.id, req.user.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Device key not found' });
  res.json({ revoked: true });
}));

module.exports = router;
