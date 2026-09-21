const express = require('express');
const db = require('../db');
const { requireUser, generateViewerKey } = require('../auth');
const asyncHandler = require('../lib/asyncHandler');
const { isUuid } = require('../lib/validators');

const router = express.Router();

// Max NON-revoked viewer keys per user. Caregiver installs come and go
// (reinstall, new phone), and each mint is a new key, so this is a generous
// ceiling meant only to stop runaway minting - not a real limit on people.
const MAX_ACTIVE_VIEWER_KEYS = 10;
const MAX_LABEL_LENGTH = 100;

// Every route here is JWT-only (requireUser): a viewer key can never mint,
// list or revoke viewer keys, and neither can an uploader key.

// Mint a read-only viewer key for the logged-in user. The raw key is
// returned exactly once, here - only its hash is stored (same as device
// keys).
router.post('/', requireUser, asyncHandler(async (req, res) => {
  const { label } = req.body || {};
  if (label !== undefined && label !== null && typeof label !== 'string') {
    return res.status(400).json({ error: 'label must be a string' });
  }
  const cleanLabel = typeof label === 'string' ? label.trim().slice(0, MAX_LABEL_LENGTH) || null : null;

  const { raw, hash, prefix } = generateViewerKey();

  // One statement: the cap check and the insert together, so two concurrent
  // mints can't both sneak in under the limit by checking before either
  // inserts. Zero rows back = the WHERE (the cap) said no. Explicit casts so
  // Postgres never has to guess a parameter's type.
  const { rows } = await db.query(
    `INSERT INTO device_keys (user_id, key_hash, key_prefix, label, role)
     SELECT $1::uuid, $2::text, $3::text, $4::text, 'viewer'
     WHERE (SELECT COUNT(*) FROM device_keys
            WHERE user_id = $1::uuid AND role = 'viewer' AND revoked_at IS NULL) < $5::int
     RETURNING id`,
    [req.user.id, hash, prefix, cleanLabel, MAX_ACTIVE_VIEWER_KEYS],
  );
  if (rows.length === 0) {
    return res.status(409).json({
      error: `You already have ${MAX_ACTIVE_VIEWER_KEYS} active viewer keys. Revoke one you no longer use, then try again.`,
    });
  }

  res.status(201).json({ id: rows[0].id, key: raw });
}));

// The caller's viewer keys (revoked ones included, so a client can see the
// history). Never the raw key or its hash.
router.get('/', requireUser, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, label, key_prefix, created_at, last_used_at, revoked_at
     FROM device_keys
     WHERE user_id = $1 AND role = 'viewer'
     ORDER BY created_at DESC`,
    [req.user.id],
  );
  res.json(rows.map(r => ({
    id: r.id,
    label: r.label,
    key_prefix: r.key_prefix,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    revoked_at: r.revoked_at,
  })));
}));

// Own viewer keys only - someone else's id (or a device key's id, or an
// already-revoked one) is a 404, same as routes/devices.js.
router.post('/:id/revoke', requireUser, asyncHandler(async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Viewer key not found' });
  const { rows } = await db.query(
    `UPDATE device_keys SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND role = 'viewer' AND revoked_at IS NULL
     RETURNING id`,
    [req.params.id, req.user.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Viewer key not found' });
  res.json({ revoked: true });
}));

module.exports = router;
