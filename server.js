const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors()); // allows your GitHub Pages dashboard to call this server
app.use(express.json());

const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // set this in Railway, never in code
const isDryRun = process.env.AHEAD_TEST_MODE === 'true' || req.body.dryRun === true;
const DRY_RUN = process.env.AHEAD_TEST_MODE === 'true';
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
if (DRY_RUN) {
      console.log('[DRY RUN] Prompt that would have been sent:');
      console.log(prompt);
      return res.json({
        text: "OPTION 1: [DRY RUN] Fake response, no API call made.\nOPTION 2: [DRY RUN] Wiring works if you're seeing this.\nOPTION 3: [DRY RUN] Flip DRY_RUN off in Railway when ready to go live."
      });
    }
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
      return res.status(500).json({ error: data.error.message });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response received.';
    res.json({ text });

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Ahead backend listening on port ${PORT}`);
});
