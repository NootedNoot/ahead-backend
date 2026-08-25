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
 *   minutesSinceLastBolus: number|null, // null if no INSULIN event has ever been logged, or if the logged one is somehow after this reading
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

    // 2026-08-25: enabled now that ahead-android's INSULIN event tag
    // populates minutesSinceLastBolus (see server.js's per-reading
    // computation). Still fires on minutesSinceLastBolus == null (no bolus
    // ever logged) - that's not a missing-data gap, it's itself informative
    // for a user who hasn't started logging yet, same as before this was
    // wired up, just now also correctly quiets down once real logging shows
    // a bolus was recent (see the < 180 exclusion below).
    if (context.minutesSinceLastBolus == null || context.minutesSinceLastBolus > 180) {
      guesses.push({ label: 'Possible missed or late bolus?', confidence: context.minutesSinceLastBolus == null ? 'low' : 'high' });
    }
  }

  // ---------- LOW-side event ----------
  if (currentValue < 80) {
    if (rate < -1.0) {
      guesses.push({ label: 'Recent exercise pulling you down?', confidence: 'medium' });
    }
    if (Math.abs(rate) < 0.5) {
      guesses.push({ label: 'Slow drift low - a snack worth considering?', confidence: 'low' });
    }
    // Compression lows are a well-known CGM artifact: pressure on the sensor
    // site (lying on it, tight clothing) can squeeze interstitial fluid flow
    // and report a falsely low value, classically overnight. Nighttime window
    // mirrors the existing dawn-phenomenon check's use of timeOfDayHour above.
    // Not gated on any fingerstick value - no such input exists yet - this is
    // a standing possible-explanation prompt for a low in that window.
    if (context.timeOfDayHour >= 0 && context.timeOfDayHour <= 6) {
      guesses.push({
        label: 'Possible compression low - any pressure on the sensor site (sitting, lying on it, tight clothing)?',
        confidence: 'low',
      });
    }

    // 2026-08-25: enabled alongside the high-side block above. Unlike that
    // one, this only fires on a CONFIRMED recent bolus (never on null) -
    // "insulin still working" is an assertion about something that
    // definitely happened, not a reasonable guess to make from an absence
    // of data.
    if (context.minutesSinceLastBolus != null && context.minutesSinceLastBolus < 120) {
      guesses.push({ label: 'Insulin from a recent bolus still working?', confidence: 'high' });
    }
  }

  // Rebound from a treated low: a genuine dip in the recent ~40 min followed by
  // a climb back out of it. Checked regardless of the current band so it's
  // caught mid-rebound (e.g. 46 -> 69 rising) instead of falling to "no clear
  // pattern" - which is exactly what live testing hit.
  if (reboundingFromLow(readings, rate)) {
    guesses.push({ label: 'Possible rebound from a recent low?', confidence: 'medium' });
  }

  // Sensor/fingerstick mismatch: the sensor reads interstitial fluid, which
  // trails actual blood glucose by several minutes, so a fingerstick can
  // meaningfully disagree with the sensor trend during a fast move in either
  // direction - a fast rise means blood glucose may already be higher than
  // shown, a fast fall means it may already be lower. Deliberately not gated
  // on an actual fingerstick reading (none is logged yet, out of scope for
  // this pass) - this is a standing possible-explanation prompt for events
  // fast enough that the lag is worth asking about. Checked regardless of
  // band, same as the rebound check above.
  if (Math.abs(rate) >= 1.5) {
    guesses.push({
      label: 'Interstitial fluid lag - could your blood glucose already be ahead of what the sensor shows?',
      confidence: 'low',
    });
  }

  if (guesses.length === 0) {
    guesses.push({ label: 'No clear pattern - worth a manual check?', confidence: 'low' });
  }

  // The dashboard initially shows two hypotheses and can expand to a third.
  // Give an active event three distinct, deliberately low-confidence prompts
  // rather than leaving the user with a partly empty "possible explanations"
  // area. These remain questions, not a claim about what caused the glucose.
  addContextPrompts(guesses, currentValue, rate);
  return rankAndTrim(guesses);
}

function addContextPrompts(guesses, currentValue, rate) {
  const prompts = ifHigh(currentValue)
    ? [
        'Could a recent meal still be digesting?',
        'Could a change in routine, stress, or illness be contributing?',
        'Does this pattern repeat around this time of day?',
      ]
    : ifLow(currentValue)
      ? [
          'Could recent activity or a routine change be contributing?',
          'Does this pattern repeat around this time of day?',
          'Could a recent meal timing change be contributing?',
        ]
      : rate < 0
        ? [
            'Could recent activity or a routine change be contributing?',
            'Does this pattern repeat around this time of day?',
            'Could a recent meal timing change be contributing?',
          ]
        : [
            'Could a recent food, activity, or routine change be contributing?',
            'Does this pattern repeat around this time of day?',
            'Is there anything different about today worth noting?',
          ];

  for (const label of prompts) {
    if (guesses.length >= 3) break;
    guesses.push({ label, confidence: 'low' });
  }
}

function ifHigh(value) { return value >= 180; }
function ifLow(value) { return value < 80; }

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

/** True when the recent ~40 min contains a genuine low and glucose is now
 *  climbing clearly back out of it - a rebound in progress. */
function reboundingFromLow(readings, rate) {
  if (rate <= 0 || !readings || readings.length < 2) return false;
  const recent = readings.slice(-9); // ~40 min at 5-min cadence
  const min = Math.min(...recent.map(r => r.sgv));
  const current = recent[recent.length - 1].sgv;
  return min < 70 && current > min + 5;
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
