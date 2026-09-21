-- Migration: 2026-09-20 - viewer keys (read-only long-lived keys for Ahead Lite)
--
-- Adds device_keys.role. Idempotent: safe to run more than once (the second
-- run is a no-op that prints a NOTICE). Existing rows get 'uploader' from
-- the default, so every existing device key keeps working exactly as before.
--
-- RUN THIS BEFORE deploying the code that reads the column (see
-- docs/ACCOUNT_API.md, "Safe deployment order"). Run it in the Supabase SQL
-- editor (or: psql "$DATABASE_URL" -f migrations/2026-09-20_viewer_keys.sql).
-- It is a metadata-only change on Postgres 11+ (no table rewrite) and takes
-- a very brief lock on device_keys.
--
-- This repo's convention until now was a single schema.sql that is safe to
-- re-run. This directory is the first place a change ships as its own file
-- so it can be applied to a live database on its own; the same statement is
-- also in schema.sql so fresh installs get it.

ALTER TABLE device_keys
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'uploader'
  CHECK (role IN ('uploader', 'viewer'));

-- Quick check after running (expect every existing row to say 'uploader'):
--   SELECT role, COUNT(*) FROM device_keys GROUP BY role;

-- ROLLBACK (only if the feature must be backed out). ORDER MATTERS:
--   1. Revoke every viewer key FIRST. Code from before this change ignores
--      the role column, so an un-revoked viewer key would authenticate as a
--      full uploader key on old code.
--        UPDATE device_keys SET revoked_at = now()
--         WHERE role = 'viewer' AND revoked_at IS NULL;
--   2. Deploy the previous code.
--   3. Optional, and not needed for safety - the column is harmless to leave:
--        ALTER TABLE device_keys DROP COLUMN role;
