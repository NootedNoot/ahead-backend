-- Ahead backend schema — multi-tenant accounts, device keys, readings,
-- family sharing, and the admin/audit/security layer.
-- Run this once against the Supabase Postgres connection string (Supabase's
-- SQL editor, or `psql "$DATABASE_URL" -f schema.sql`) before starting the
-- server with the new code. Safe to re-run: every statement is idempotent.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive email

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          CITEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  display_name   TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  disabled_at    TIMESTAMPTZ,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- status is what makes "disable user" take effect immediately: every
-- protected request re-checks status='active' against this row (see
-- auth.js), not just the JWT's own signature/expiry. No blacklist table
-- needed - disabling flips one column, and the user's very next request
-- (even with a still-unexpired 30-day token) gets 401'd.

-- 2026-08-27 (password reset + email verification): email_verified_at is
-- null until the account clicks a real verification link (see
-- email_tokens below) - gates nothing about the account's OWN usage
-- (login/signup/upload all work unverified), only whether OTHER people
-- can be granted a share naming this account as the viewer (see
-- routes/shares.js) - the actual gap being closed is "does the email
-- string on a share grant really belong to whoever's using that account,"
-- not a general email-verification wall.
--
-- token_version is embedded in every JWT issued for this user and
-- re-checked live on every request exactly like status is. Bumping it
-- (done on every password reset) invalidates every other outstanding
-- session token for this account with no blacklist table needed - the
-- same trick status already uses, generalized.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- 2026-08-29: is_owner marks a REGULAR user account (not an admin - see
-- the separate `admins` table below) as belonging to Ryan himself, so both
-- Android apps can gate developer-only tooling (the debug menu) on WHICH
-- ACCOUNT is logged in, not just "is this a debug build." A debug build's
-- only real distribution control today is Ryan handing out the APK
-- himself, but the moment a real family member logs into that same debug
-- build with their own caregiver account, BuildConfig.DEBUG alone would
-- have shown them developer tooling meant only for Ryan. Deliberately NOT
-- self-service and NOT settable via any user-facing endpoint - only
-- flippable through the admin panel (see routes/admin.js's
-- POST /users/:id/set-owner), same "no admin action without an audit
-- trail" discipline every other privilege change in this schema follows.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT false;

-- Separate from `users` entirely - admins are not self-serve, sign a
-- DIFFERENT JWT with a DIFFERENT secret (ADMIN_JWT_SECRET) so a regular
-- user's token can never be replayed against an admin endpoint. No signup
-- endpoint exists for this table on purpose - seed manually, see
-- scripts/seed-admin.js.
CREATE TABLE IF NOT EXISTS admins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash      TEXT NOT NULL UNIQUE,   -- HMAC-SHA256(rawKey, DEVICE_KEY_PEPPER), hex
  key_prefix    TEXT NOT NULL,          -- first 12 raw chars, for UI/log identification only
  label         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_device_keys_user_id ON device_keys(user_id);

-- One table for both password-reset and email-verify tokens - same
-- lifecycle either way (generate, email, single-use, expire), no reason to
-- duplicate it into two tables. Same hashed-at-rest pattern as
-- device_keys.key_hash above: token_hash = HMAC-SHA256(rawToken,
-- EMAIL_TOKEN_PEPPER), a separate pepper from DEVICE_KEY_PEPPER on
-- purpose - every secret in this app is scoped to exactly one concern (see
-- auth.js's own doc), never shared across unrelated credential types.
CREATE TABLE IF NOT EXISTS email_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('password_reset', 'email_verify')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user_id ON email_tokens(user_id, purpose);

-- Every admin action that changes state, with a reason. target_user_id/
-- target_device_id are nullable so one table covers every action type.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id         UUID NOT NULL REFERENCES admins(id),
  action           TEXT NOT NULL,   -- 'disable_user' | 'enable_user' | 'revoke_device'
  target_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  target_device_id UUID REFERENCES device_keys(id) ON DELETE SET NULL,
  reason           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- ON DELETE SET NULL (not CASCADE) deliberately - if a user is later
-- deleted entirely, the audit row recording that an admin once disabled
-- them should still exist for the historical record; it just loses its
-- now-meaningless target link instead of vanishing with them.
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target_user ON admin_audit_log(target_user_id);

-- Every login/signup ATTEMPT, success or failure, both regular users and
-- admins (is_admin_attempt distinguishes them in one shared table). Powers
-- the failed-login log, the per-user/per-IP view, and the "flagged"
-- computation - all query-time against this table, no separate counter to
-- keep in sync.
CREATE TABLE IF NOT EXISTS auth_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_attempted  CITEXT NOT NULL,
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  is_admin_attempt BOOLEAN NOT NULL DEFAULT false,
  success          BOOLEAN NOT NULL,
  ip_address       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_events_user_id ON auth_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_events_ip ON auth_events(ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_events_email ON auth_events(email_attempted, created_at DESC);

-- One row per request that got rate-limited (not one row per request
-- overall), wired via express-rate-limit's custom `handler` callback.
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_ip ON rate_limit_hits(ip_address, created_at DESC);

CREATE TABLE IF NOT EXISTS readings (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reading_time_ms BIGINT NOT NULL,   -- epoch ms, exactly what the app sends as `date`
  sgv             INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, reading_time_ms)
);
-- Composite PK is the idempotency constraint - ahead-android resends a
-- trailing 45-min window every ~5 min cycle. Upsert with
-- ON CONFLICT (user_id, reading_time_ms) DO UPDATE SET sgv = EXCLUDED.sgv.
-- Same PK also serves "MAX(reading_time_ms) WHERE user_id=$1" and "last N
-- readings for user X" without a second index.

CREATE TABLE IF NOT EXISTS shares (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewer_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, viewer_id),
  CHECK (owner_id <> viewer_id)
);
CREATE INDEX IF NOT EXISTS idx_shares_viewer_id ON shares(viewer_id);
