// guess-engine.js
// Rule-based contextual guesses for a glucose EVENT - up to 4 ranked
// hypotheses for why glucose is doing what it's doing right now.
//
// v1 is deterministic rules. The shape is deliberately LLM-swappable: to move
// to a Gemini-generated guess later, replace the body of generateGuesses() with
// an API call that returns the same Guess[] and nothing else in the app changes.
//
//   Guess = { label: string, confidence: 'high' | 'medium' | 'low' }
//
// Two hard rules from the spec:
//   1. Guesses are always phrased as QUESTIONS / hypotheses, never asserted as
//      fact ("Possible missed bolus?" not "You missed your bolus").
//   2. Only call this during an actual event (YELLOW/RED or sustained
//      out-of-range). There's nothing to explain about a flat 100.

const MAX_GUESSES = 4;
const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

/**
 * context = {
 *   currentValue: number,
 *   rate: number,                       // mg/dL/min, reactive
 *   severity: 'none' | 'yellow' | 'red',
 *   readings: [{ sgv, date }],          // recent, oldest -> newest
 *   timeOfDayHour: number,              // 0-23 local
 *   minutesSinceLastBolus: number|null, // null until bolus logging exists
 * }
 */
function generateGuesses(context) {
  if (!context || !isEventful(context)) return [];

  const { currentValue, rate, readings } = context;
  const guesses = [];

  // ---------- HIGH-side event ----------
  if (currentValue >= 180) {
    if (rate > 1.0) {
      guesses.push({ label: 'High-carb meal not yet covered?', confidence: rate > 2.0 ? 'high' : 'medium' });
    }
    if (context.timeOfDayHour >= 4 && context.timeOfDayHour <= 9 && rate > 0) {
      guesses.push({ label: 'Dawn phenomenon?', confidence: 'medium' });
    }
    if (Math.abs(rate) < 0.5 && sustainedHigh(readings)) {
      guesses.push({ label: 'Infusion site or pump not delivering?', confidence: 'low' });
      guesses.push({ label: 'Stress or illness raising your baseline?', confidence: 'low' });
    }
    if (recentLow(readings)) {
      guesses.push({ label: 'Rebound from an earlier low (over-treated)?', confidence: 'medium' });
    }

    /* ===== BOLUS-DEPENDENT HIGH-SIDE GUESSES - DISABLED ==================
       Turn this block ON once bolus/insulin logging populates
       context.minutesSinceLastBolus. It stays commented so it can never fire
       on null data before the feature is ready - to enable, just delete the
       two comment-marker lines around it.

    if (context.minutesSinceLastBolus == null || context.minutesSinceLastBolus > 180) {
      guesses.push({ label: 'Possible missed or late bolus?', confidence: 'high' });
    }
    ==================================================================== */
  }

  // ---------- LOW-side event ----------
  if (currentValue < 80) {
    if (rate < -1.0) {
      guesses.push({ label: 'Recent exercise pulling you down?', confidence: 'medium' });
    }
    if (Math.abs(rate) < 0.5) {
      guesses.push({ label: 'Slow drift low - a snack worth considering?', confidence: 'low' });
    }

    /* ===== BOLUS-DEPENDENT LOW-SIDE GUESSES - DISABLED ===================
       Enable alongside the high-side block above when bolus logging lands.

    if (context.minutesSinceLastBolus != null && context.minutesSinceLastBolus < 120) {
      guesses.push({ label: 'Insulin from a recent bolus still working?', confidence: 'high' });
    }
    ==================================================================== */
  }

  if (guesses.length === 0) {
    guesses.push({ label: 'No clear pattern - worth a manual check?', confidence: 'low' });
  }

  return rankAndTrim(guesses);
}

function isEventful(ctx) {
  return ctx.severity === 'yellow' || ctx.severity === 'red' || sustainedOutOfRange(ctx.readings);
}

/** Last two readings both clearly high. */
function sustainedHigh(readings) {
  if (!readings || readings.length < 2) return false;
  return readings.slice(-2).every(r => r.sgv >= 180);
}

/** Any of the last ~6 readings dipped below 70. */
function recentLow(readings) {
  if (!readings) return false;
  return readings.slice(-6).some(r => r.sgv < 70);
}

/** Two or more consecutive most-recent readings outside 80-160. */
function sustainedOutOfRange(readings) {
  if (!readings || readings.length < 2) return false;
  const last = readings.slice(-2);
  return last.every(r => r.sgv < 80 || r.sgv > 160);
}

/** Sort by confidence (high first), drop duplicate labels, cap at MAX_GUESSES. */
function rankAndTrim(guesses) {
  const seen = new Set();
  return guesses
    .filter(g => (seen.has(g.label) ? false : seen.add(g.label)))
    .sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence])
    .slice(0, MAX_GUESSES);
}

module.exports = { generateGuesses, MAX_GUESSES };
