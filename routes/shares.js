const express = require('express');
const db = require('../db');
const { requireUser } = require('../auth');
const asyncHandler = require('../lib/asyncHandler');

const router = express.Router();

// Everything the logged-in user can VIEW: their own stream first, then
// anyone who's shared with them. Drives ahead-lite-android's stream picker
// (auto-select if this array has exactly one entry).
router.get('/accessible', requireUser, asyncHandler(async (req, res) => {
  const { rows: shared } = await db.query(
    `SELECT u.id AS owner_id, u.email AS owner_email
     FROM shares s JOIN users u ON u.id = s.owner_id
     WHERE s.viewer_id = $1
     ORDER BY u.email`,
    [req.user.id],
  );
  res.json([
    { ownerId: req.user.id, ownerEmail: req.user.email, isSelf: true },
    ...shared.map(r => ({ ownerId: r.owner_id, ownerEmail: r.owner_email, isSelf: false })),
  ]);
}));

// Shares this user has GRANTED (they're the owner) - the manage-sharing
// screen in ahead-android.
router.get('/', requireUser, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT s.id, u.email AS viewer_email, s.created_at
     FROM shares s JOIN users u ON u.id = s.viewer_id
     WHERE s.owner_id = $1
     ORDER BY s.created_at DESC`,
    [req.user.id],
  );
  res.json(rows.map(r => ({ shareId: r.id, viewerEmail: r.viewer_email, createdAt: r.created_at })));
}));

router.post('/', requireUser, asyncHandler(async (req, res) => {
  const { viewerEmail } = req.body || {};
  if (typeof viewerEmail !== 'string' || !viewerEmail.trim()) {
    return res.status(400).json({ error: 'viewerEmail is required' });
  }
  if (viewerEmail.trim().toLowerCase() === req.user.email.toLowerCase()) {
    return res.status(400).json({ error: "You can't share with yourself" });
  }

  // email_verified_at gate (2026-08-27): closes the real gap this was
  // flagged for - a share grant names a viewer by email string alone, so
  // without this, anyone could sign up with an email they don't actually
  // control and get granted access meant for its real owner. Doesn't gate
  // anything about the VIEWER's own account usage (see users.email_verified_at's
  // schema.sql comment) - only whether they can be the target of someone
  // else's share grant.
  const { rows: viewerRows } = await db.query('SELECT id, email_verified_at FROM users WHERE email = $1', [viewerEmail.trim()]);
  if (viewerRows.length === 0) {
    return res.status(404).json({ error: 'No account found for that email. Ask them to sign up first, then try again.' });
  }
  if (!viewerRows[0].email_verified_at) {
    return res.status(403).json({ error: "That account hasn't verified their email yet - ask them to check their inbox, then try again." });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO shares (owner_id, viewer_id) VALUES ($1, $2) RETURNING id`,
      [req.user.id, viewerRows[0].id],
    );
    res.status(201).json({ shareId: rows[0].id, viewerEmail: viewerEmail.trim() });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Already shared with that person' });
    throw err;
  }
}));

router.delete('/:id', requireUser, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `DELETE FROM shares WHERE id = $1 AND owner_id = $2 RETURNING id`,
    [req.params.id, req.user.id],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Share not found' });
  res.json({ revoked: true });
}));

module.exports = router;
