# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Express.js API server (Railway-hosted) that does server-side trend detection and guess generation. Called by `ahead-android` and `ahead-dashboard`. See `../CLAUDE.md` for how this fits with the rest of the Ahead ecosystem.

`README.txt` is stale — it documents a `POST /analyze` Gemini endpoint that has been **removed** (the AI-analysis "Ask Ahead" feature was deliberately pulled from backend, Android, and dashboard as premature without insulin-on-board/food context). Don't trust it for current API surface; trust `server.js` directly.

## Commands

```bash
npm install
npm start                                    # node server.js, requires AHEAD_API_KEY env var set
npm test                                     # node --test (runs everything in test/)
node --test test/trend-detector.test.js      # single test file
node --test test/guess-engine.test.js        # the other test file
```

Local smoke test without a real deploy: `AHEAD_API_KEY=test123 node server.js` — should print `Ahead backend listening on port 3000` with no errors.

## Architecture

### Auth & rate limiting (`server.js`)

Every protected route goes through `requireApiKey` (checks `X-Ahead-Api-Key` against `process.env.AHEAD_API_KEY` via `crypto.timingSafeEqual`; **fails closed** — if the env var isn't set, it 500s rather than accepting anyone) and `apiLimiter` (`express-rate-limit`, 60 req/5min, `trust proxy` set to 1 since Railway sits in front as a reverse proxy).

**Currently deployed with this middleware in code but not actually enforced end-to-end**: Railway's env vars for this service don't include `AHEAD_API_KEY`, and neither `ahead-android`'s `BackendClient.kt` nor `ahead-dashboard` sends the `X-Ahead-Api-Key`/`X-Ahead-Device-Id` headers. Deploying the currently-checked-out branch as-is without also updating both clients would break the app. Check Railway's actual deployed branch/commit and live env vars (not just this repo's `main`) before assuming what's actually running in production.

Per-device state (`deviceStates`, an in-memory `Map` keyed by `X-Ahead-Device-Id`) tracks `lastProcessedDate`/`latestTrend` per caller — intentionally not a single shared global, so one device's readings can't silently overwrite or spoof another's. It's in-memory only (resets on restart/redeploy) and won't survive a move to multi-instance hosting without a real store.

### Trend detection (`trend-detector.js`)

`processNewReading(readings, { sendPushNotification, tuning })` is a **separate, independent implementation** of trend/severity logic from `ahead-android`'s on-device Kotlin plateau/correction-response math (`PlateauMath.kt`, `CorrectionResponseMath.kt`) — don't conflate the two or assume changing one changes the other. This one is proximity-to-danger based: it projects glucose forward (`projectGlucose`, `PROJECTION_MINUTES`) and classifies severity (`classifySeverity`) as `none | yellow | red` primarily off where the *projection* lands, with a fast-rate escalation path that can push straight to yellow independent of projection, and a RED-projection confirmation step (`assessRateTrajectory` + friends) that requires the last few rate calculations to agree before allowing a full RED takeover — guards against one noisy/outlier reading triggering a false full-screen alert. All the thresholds are grouped under `// ---- TUNING KNOBS ----` at the top of the file and are meant to be adjusted against real data.

`sendPushNotification` is currently a stub (`[STUB PUSH]` console log) — no real push provider is wired up since the Android app doesn't register device tokens yet.

### Guess engine (`guess-engine.js`)

`generateGuesses(context)` produces contextual explanations for a trend event (why might this be happening) given current value/rate/severity/reading history/time-of-day. `minutesSinceLastBolus` is accepted but always passed `null` from `server.js` currently — bolus-dependent guess rules are wired but effectively disabled until bolus history is actually tracked somewhere upstream.

### Routes

- `GET /` — health check.
- `GET /api/latest-trend` — returns the caller's cached `latestTrend` (404 if none yet).
- `POST /api/check-trend` — takes `{ readings, tuning }`, diffs against `lastProcessedDate` to find genuinely new readings, runs each through `processNewReading` + `generateGuesses`, updates per-device state, returns `{ processed: [...] }`.
