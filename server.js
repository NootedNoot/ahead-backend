const express = require('express');
const cors = require('cors');
const { processNewReading } = require('./trend-detector');
const { generateGuesses } = require('./guess-engine');
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DRY_RUN = process.env.AHEAD_TEST_MODE === 'true';

app.use((req, res, next) => {
  req.dryRun = req.body?.dryRun === true || DRY_RUN;
  next();
});

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

// In-memory only - resets on restart/redeploy. Fine for a single-user,
// single-process deployment; if this ever runs multi-instance or needs to
// survive restarts without a brief catch-up gap, move this to a real store.
let lastProcessedDate = null;
let latestTrend = null;

app.get('/api/latest-trend', (req, res) => {
  if (!latestTrend) {
    return res.status(404).json({ error: 'No trend data yet' });
  }
  res.json(latestTrend);
});

app.post('/api/check-trend', async (req, res) => {
  try {
    const { readings, tuning } = req.body;

    if (!Array.isArray(readings) || readings.length < 2) {
      return res.status(400).json({ error: 'Missing or insufficient glucose readings (need at least 2)' });
    }

    const sorted = [...readings].sort((a, b) => a.date - b.date);

    const newReadings = lastProcessedDate === null
      ? [sorted[sorted.length - 1]]
      : sorted.filter(r => r.date > lastProcessedDate);

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

    lastProcessedDate = newReadings[newReadings.length - 1].date;
    latestTrend = results[results.length - 1];

    res.json({ processed: results });

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Ahead backend listening on port ${PORT}`);
});
