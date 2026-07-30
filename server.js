const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { processNewReading } = require('./trend-detector');
const { generateGuesses } = require('./guess-engine');
const app = express();

// Railway sits in front of this app behind a reverse proxy - without this,
// express-rate-limit sees every request as coming from the proxy's single IP
// (either lumping all callers into one shared bucket, or throwing on startup
// in newer versions that detect the misconfiguration).
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ---- Shared-secret auth ----
// Every real client request carries X-Ahead-Api-Key, checked against this
// server's own env var. Fails CLOSED if the env var isn't set - a misconfigured
// deployment should refuse traffic, not silently accept anyone.
const AHEAD_API_KEY = process.env.AHEAD_API_KEY;

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireApiKey(req, res, next) {
  if (!AHEAD_API_KEY) {
    console.error('AHEAD_API_KEY is not set - rejecting all requests to protected endpoints');
    return res.status(500).json({ error: 'Server misconfigured' });
  }
  const provided = req.get('X-Ahead-Api-Key');
  if (!provided || !timingSafeStringEqual(provided, AHEAD_API_KEY)) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

// ---- Rate limiting ----
// Generous enough for real usage (Worker polls every ~15 min, plus manual
// "Check now" taps and debug scenario playback bursts) while still blocking
// an anonymous or accidental flood.
const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again shortly.' },
});

// Stub - no real push provider wired up yet (Android app doesn't register
// device tokens yet). Swap this out once FCM/APNs/etc. is in place.
async function sendPushNotification(message) {
  console.log('[STUB PUSH]', message);
  return { stub: true, message };
}

app.get('/', (req, res) => {
  res.send('Ahead backend is running.');
});

// In-memory only - resets on restart/redeploy. Keyed per-device (see
// getDeviceState below) rather than two bare globals: with more than one
// device hitting this same deployment (multi-user beta testing, or anyone
// else who finds the URL), a shared global would let one caller's readings
// overwrite another's - at best cross-contaminated trend data, at worst a
// forged far-future timestamp silently swallowing a real subsequent reading
// (see the newReadings filter below) or a forged severity firing a false
// alert on someone else's device. If this ever runs multi-instance, move
// this to a real store - a single process's Map won't survive that.
const deviceStates = new Map();

function getDeviceId(req) {
  return req.get('X-Ahead-Device-Id') || null;
}

function getDeviceState(deviceId) {
  let state = deviceStates.get(deviceId);
  if (!state) {
    state = { lastProcessedDate: null, latestTrend: null };
    deviceStates.set(deviceId, state);
  }
  return state;
}

app.get('/api/latest-trend', apiLimiter, requireApiKey, (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) {
    return res.status(400).json({ error: 'Missing X-Ahead-Device-Id header' });
  }
  const state = deviceStates.get(deviceId);
  if (!state || !state.latestTrend) {
    return res.status(404).json({ error: 'No trend data yet' });
  }
  res.json(state.latestTrend);
});

app.post('/api/check-trend', apiLimiter, requireApiKey, async (req, res) => {
  try {
    const deviceId = getDeviceId(req);
    if (!deviceId) {
      return res.status(400).json({ error: 'Missing X-Ahead-Device-Id header' });
    }
    const state = getDeviceState(deviceId);

    const { readings, tuning } = req.body;

    if (!Array.isArray(readings) || readings.length < 2) {
      return res.status(400).json({ error: 'Missing or insufficient glucose readings (need at least 2)' });
    }

    const sorted = [...readings].sort((a, b) => a.date - b.date);

    const newReadings = state.lastProcessedDate === null
      ? [sorted[sorted.length - 1]]
      : sorted.filter(r => r.date > state.lastProcessedDate);

    if (newReadings.length === 0) {
      return res.json({ processed: [] });
    }

    const results = [];
    for (const reading of newReadings) {
      const historyUpToHere = sorted.filter(r => r.date <= reading.date);
      const result = await processNewReading(historyUpToHere, { sendPushNotification, tuning });
      // Contextual guesses ride along only for actual events (the engine
      // returns [] otherwise). Bolus history isn't wired yet, so pass null -
      // the bolus-dependent rules are disabled until that lands.
      const guesses = generateGuesses({
        currentValue: result.currentValue,
        rate: result.rate,
        severity: result.severity,
        readings: historyUpToHere,
        timeOfDayHour: new Date(reading.date).getHours(),
        minutesSinceLastBolus: null,
      });
      results.push({ date: reading.date, ...result, guesses });
    }

    state.lastProcessedDate = newReadings[newReadings.length - 1].date;
    state.latestTrend = results[results.length - 1];

    res.json({ processed: results });

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Ahead backend listening on port ${PORT}`);
});
