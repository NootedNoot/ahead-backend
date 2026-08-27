const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { processNewReading } = require('./trend-detector');
const { generateGuesses } = require('./guess-engine');
const db = require('./db');
const { requireDeviceKey, clientIp } = require('./auth');

const authRoutes = require('./routes/auth-routes');
const devicesRoutes = require('./routes/devices');
const sharesRoutes = require('./routes/shares');
const readingsRoutes = require('./routes/readings');
const adminRoutes = require('./routes/admin');

const app = express();

// Railway sits in front of this as a single reverse-proxy hop - without
// trust proxy, req.ip would be Railway's own internal address for every
// request, which would make every auth_events row and every rate-limit
// bucket collapse onto one fake "IP." Set to 1 (not `true`): `true` trusts
// the ENTIRE X-Forwarded-For chain, including any value a client sends
// before it ever reaches Railway - meaning anyone could just claim to be a
// different IP and dodge rate limiting entirely. `1` trusts exactly the
// nearest hop (Railway's own edge) and nothing an attacker sends further
// back in the chain.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DRY_RUN = process.env.AHEAD_TEST_MODE === 'true';

app.use((req, res, next) => {
  req.dryRun = req.body?.dryRun === true || DRY_RUN;
  next();
});

// Public, self-serve auth endpoints get a real rate limit - every hit that
// trips it is logged to rate_limit_hits so the admin panel's security view
// has something to show, not just a silent 429.
const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: async (req, res) => {
    await db.query(
      'INSERT INTO rate_limit_hits (ip_address, endpoint) VALUES ($1, $2)',
      [clientIp(req), req.baseUrl + req.path],
    ).catch(err => console.error('Failed to log rate-limit hit:', err));
    res.status(429).json({ error: 'Too many requests, try again in a minute' });
  },
});

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/admin/login', authLimiter);
app.use('/api/admin', adminRoutes);
app.use('/api/devices', devicesRoutes);
app.use('/api/shares', sharesRoutes);
app.use('/api/readings', readingsRoutes);

// Raw call to Gemini. Throws on API error; caller decides how to handle it.
async function callGemini(prompt) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });

  const data = await response.json();

  if (data.error) {
    console.error('Gemini API error:', data.error);
    throw new Error(data.error.message);
  }

  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response received.';
}

// Stub - no real push provider wired up yet (Android app doesn't register
// device tokens yet). Swap this out once FCM/APNs/etc. is in place.
async function sendPushNotification(message) {
  console.log('[STUB PUSH]', message);
  return { stub: true, message };
}

app.get('/', (req, res) => {
  res.send('Ahead backend is running.');
});

app.post('/analyze', async (req, res) => {
  try {
    const { readings, latest } = req.body;

    if (!readings || !latest) {
      return res.status(400).json({ error: 'Missing glucose data' });
    }

    const prompt = `You are Ahead, a proactive CGM (continuous glucose monitor) insight tool for a Type 1 diabetic. You are NOT a doctor and do NOT give dosing advice. You help users understand their glucose trends and give practical next steps.

Here is the user's glucose data from the last few hours (oldest to newest):
${readings.map(r => `${r.time}: ${r.sgv} mg/dL ${r.direction || ''} (delta: ${r.delta})`).join('\n')}

Current reading: ${latest.sgv} mg/dL, trend: ${latest.direction}, delta: ${latest.delta} mg/dL

Based on this data:
1. Write 1-2 sentences describing what you see in plain language (no jargon).
2. Give exactly 3 short, actionable options the user might consider right now. Be specific and practical. Do NOT recommend specific insulin doses. Format them as:
OPTION 1: [text]
OPTION 2: [text]
OPTION 3: [text]

Keep the whole response under 150 words. Be direct and friendly, not clinical.`;

    if (req.dryRun) {
      console.log('[DRY RUN] Prompt that would have been sent:');
      console.log(prompt);
      return res.json({
        text: "OPTION 1: [DRY RUN] Fake response, no API call made.\nOPTION 2: [DRY RUN] Wiring works if you're seeing this.\nOPTION 3: [DRY RUN] Flip test mode off when ready to go live."
      });
    }

    const text = await callGemini(prompt);
    res.json({ text });

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Ingestion + trend analysis, now per-authenticated-device instead of one
// shared in-memory slot. Request/response shape is unchanged from before
// this rework - only the auth (X-Ahead-Api-Key, required) and the fact
// that readings are now actually persisted, per user, are new.
app.post('/api/check-trend', requireDeviceKey, async (req, res) => {
  try {
    const { readings, tuning, lastBolusTimestamp } = req.body;

    if (!Array.isArray(readings) || readings.length < 2) {
      return res.status(400).json({ error: 'Missing or insufficient glucose readings (need at least 2)' });
    }

    const sorted = [...readings].sort((a, b) => a.date - b.date);
    const userId = req.userId;

    // MUST run before the upsert below, or the rows we're about to insert
    // would be included in their own "old max."
    const { rows: maxRows } = await db.query(
      'SELECT MAX(reading_time_ms) AS old_max FROM readings WHERE user_id = $1',
      [userId],
    );
    const oldMax = maxRows[0].old_max === null ? null : Number(maxRows[0].old_max);

    for (const r of sorted) {
      await db.query(
        `INSERT INTO readings (user_id, reading_time_ms, sgv) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, reading_time_ms) DO UPDATE SET sgv = EXCLUDED.sgv`,
        [userId, r.date, r.sgv],
      );
    }

    // Mirrors the old bootstrap behavior: first-ever call for this device
    // processes only the latest reading, not the whole trailing window.
    const newReadings = oldMax === null ? [sorted[sorted.length - 1]] : sorted.filter(r => r.date > oldMax);

    if (newReadings.length === 0) {
      return res.json({ processed: [] });
    }

    const callGeminiForAnalysis = async ({ currentValue, rate, trendPhase, severity, projected, recentReadings }) => {
      const direction = rate > 0 ? 'rising' : 'falling';
      const prompt = `You are Ahead, a proactive CGM (continuous glucose monitor) insight tool for a Type 1 diabetic. You are NOT a doctor and do NOT give dosing advice. You help users understand their glucose trends and give practical next steps.

Severity flagged: ${severity.toUpperCase()}
Current reading: ${currentValue} mg/dL, ${direction} at ${Math.abs(rate).toFixed(1)} mg/dL/min (trend is ${trendPhase})
Projected glucose in 15 min: ${projected} mg/dL

Recent readings (oldest to newest): ${recentReadings.map(r => r.sgv).join(', ')}

Based on this data:
1. Write 1-2 sentences describing what you see in plain language (no jargon).
2. Give exactly 3 short, actionable options the user might consider right now. Be specific and practical. Do NOT recommend specific insulin doses. Format them as:
OPTION 1: [text]
OPTION 2: [text]
OPTION 3: [text]

Keep the whole response under 150 words. Be direct and friendly, not clinical.`;

      if (req.dryRun) {
        console.log('[DRY RUN] Prompt that would have been sent:');
        console.log(prompt);
        return "OPTION 1: [DRY RUN] Fake response, no API call made.\nOPTION 2: [DRY RUN] Wiring works if you're seeing this.\nOPTION 3: [DRY RUN] Flip test mode off when ready to go live.";
      }

      return callGemini(prompt);
    };

    const results = [];
    for (const reading of newReadings) {
      const historyUpToHere = sorted.filter(r => r.date <= reading.date);
      const result = await processNewReading(historyUpToHere, { sendPushNotification, callGeminiForAnalysis, tuning });
      const minutesSinceLastBolus = typeof lastBolusTimestamp === 'number' && lastBolusTimestamp <= reading.date
        ? Math.round((reading.date - lastBolusTimestamp) / 60000)
        : null;
      const guesses = generateGuesses({
        currentValue: result.currentValue,
        rate: result.rate,
        severity: result.severity,
        readings: historyUpToHere,
        timeOfDayHour: new Date(reading.date).getHours(),
        minutesSinceLastBolus,
      });
      results.push({ date: reading.date, ...result, guesses });
    }

    res.json({ processed: results });

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Last-resort safety net: asyncHandler routes errors here via next(err)
// instead of crashing the process. Must be registered after every route.
// Never echoes err.message for unexpected errors - only the routes that
// deliberately construct a user-facing message (validation, auth) do that
// themselves before this is ever reached.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Ahead backend listening on port ${PORT}`);
});
