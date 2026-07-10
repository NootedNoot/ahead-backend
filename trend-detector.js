// trend-detector.js
// Call processNewReading() every time a new Nightscout reading lands (every ~5 min).
// Severity is now tiered: 'none' | 'yellow' | 'red'.
// Yellow = normal push. Red = full-screen intent / phone lock takeover territory.
// Everything under TUNING KNOBS is meant to get messed with. These are starting
// guesses - play with them against your real data for a few days and adjust.

// ---- TUNING KNOBS ----

// Projection + lookback windows
const PROJECTION_MINUTES = 15;
const LOOKBACK_MINUTES = 20; // feeds the overall rate used for the projection
// Longer horizon used only for the "fast move heading toward danger" yellow
// nudge: if the current slope extended this far out would reach a red zone, warn
// now even though the 15-min projection hasn't quite gotten there yet.
const EXTENDED_PROJECTION_MINUTES = 30;

// Two-window comparison - detects accelerating vs decelerating. Still computed
// and surfaced to the app for passive display, but it no longer influences
// severity (a slowing/reversing trend used to downgrade alerts; that rule is
// gone in favour of pure proximity-to-danger tiering).
const RECENT_WINDOW_MINUTES = 10;
const PRIOR_WINDOW_MINUTES = 10;
const TREND_PHASE_NOISE_FLOOR = 0.3; // mg/dL/min - smaller diffs than this = just noise, not a real phase change

// Display-only band. countConsecutiveOutOfRange reports how many of the most
// recent readings sit outside this range, purely as context for the app - this
// no longer feeds severity (it used to fire yellow on any value above 160,
// which is what made mildly-high-but-falling readings like 198 or 163 noisy).
const OUT_OF_RANGE_LOW = 80;
const OUT_OF_RANGE_HIGH = 160;

// Severity is proximity-based: it keys off where glucose is PROJECTED to land,
// not how fast it's moving. Rate is shown as context but never escalates on its
// own while the projection stays in a safe range.
//   Yellow: projection approaching a caution zone.
//   Red:    projection crossing a real danger threshold.
const YELLOW_PROJECTED_LOW = 90;
const YELLOW_PROJECTED_HIGH = 200;
const RED_PROJECTED_LOW = 70;
const RED_PROJECTED_HIGH = 250;

/**
 * Rate of change (mg/dL/min) using the oldest and newest reading inside a
 * window ending at windowEndTime, going back windowMinutes.
 * readings must be sorted oldest -> newest.
 */
function rateInWindow(readings, windowEndTime, windowMinutes) {
  const cutoff = windowEndTime - windowMinutes * 60 * 1000;
  const inWindow = readings.filter(r => r.date > cutoff && r.date <= windowEndTime);

  if (inWindow.length < 2) return null;

  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  const minutesElapsed = (last.date - first.date) / 60000;

  if (minutesElapsed === 0) return null;

  return (last.sgv - first.sgv) / minutesElapsed;
}

/**
 * Original overall-rate calc, kept as-is for the projection math.
 */
function calculateRate(readings) {
  const now = readings[readings.length - 1].date;
  return rateInWindow(readings, now, LOOKBACK_MINUTES);
}

function projectGlucose(currentValue, rate, minutesAhead = PROJECTION_MINUTES) {
  return Math.round(currentValue + rate * minutesAhead);
}

function countConsecutiveOutOfRange(readings) {
  let count = 0;
  for (let i = readings.length - 1; i >= 0; i--) {
    const val = readings[i].sgv;
    if (val < OUT_OF_RANGE_LOW || val > OUT_OF_RANGE_HIGH) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Compares the recent window's rate against the window before it.
 * Returns 'accelerating' | 'steady' | 'decelerating' | 'unknown'.
 * A direction reversal (was rising, now falling, or vice versa) always
 * counts as decelerating - that's the strongest "it's turning around" signal.
 */
function getTrendPhase(recentRate, priorRate) {
  if (recentRate === null || priorRate === null) return 'unknown';

  const recentSign = Math.sign(recentRate);
  const priorSign = Math.sign(priorRate);

  if (recentSign !== priorSign && recentSign !== 0 && priorSign !== 0) {
    return 'decelerating'; // reversed direction
  }

  const diff = Math.abs(recentRate) - Math.abs(priorRate);

  if (diff > TREND_PHASE_NOISE_FLOOR) return 'accelerating';
  if (diff < -TREND_PHASE_NOISE_FLOOR) return 'decelerating';
  return 'steady';
}

/**
 * The core decision: what severity does this moment deserve.
 *
 * Proximity-first: severity is a function of where glucose is PROJECTED to land,
 * not how fast it's moving. Velocity only escalates through the extended-horizon
 * nudge below, which is inherently direction-aware (extrapolating the real slope
 * further out) - so a value that's merely high-but-falling toward safe stays
 * 'none' instead of firing a pointless warning.
 */
function classifySeverity({ currentValue, rate, projected, projectedExtended }) {
  // RED: the 15-min projection crosses a real danger threshold, OR we're already
  // in a danger zone and still moving deeper into it (direction guard - a value
  // already past the threshold but heading back toward safe doesn't count).
  const projectedRed = projected <= RED_PROJECTED_LOW || projected >= RED_PROJECTED_HIGH;
  const worseningInDanger =
    (currentValue <= RED_PROJECTED_LOW && rate < 0) ||
    (currentValue >= RED_PROJECTED_HIGH && rate > 0);
  if (projectedRed || worseningInDanger) return 'red';

  // YELLOW: the projection is approaching a caution zone, OR the current slope
  // extended to the longer horizon would reach red territory (early warning on a
  // genuinely fast move - the extended projection encodes direction, so it can't
  // fire on drift heading toward safe).
  const projectedYellow = projected <= YELLOW_PROJECTED_LOW || projected >= YELLOW_PROJECTED_HIGH;
  const extendedReachesRed =
    projectedExtended <= RED_PROJECTED_LOW || projectedExtended >= RED_PROJECTED_HIGH;
  if (projectedYellow || extendedReachesRed) return 'yellow';

  return 'none';
}

function buildNotificationMessage(severity, currentValue, rate, projected) {
  const direction = rate > 0 ? 'rising' : 'falling';
  const sign = rate > 0 ? '+' : '';
  const rateStr = `${sign}${rate.toFixed(1)}`;
  const base = `${currentValue} ${direction} ${rateStr}mg/dL a min. Expected glucose in ${PROJECTION_MINUTES} mins is ${projected}.`;

  if (severity === 'red') {
    return `🔴 URGENT: ${base} Check now.`;
  }
  return `${base} Consider checking in.`;
}

/**
 * Main entry point. Call this after every new reading is stored.
 * readings: full array, sorted oldest -> newest, each { sgv, date }
 */
async function processNewReading(readings, { sendPushNotification, callGeminiForAnalysis }) {
  if (!readings || readings.length < 2) return { severity: 'none' };

  const current = readings[readings.length - 1];
  const now = current.date;

  const overallRate = calculateRate(readings);
  const recentRate = rateInWindow(readings, now, RECENT_WINDOW_MINUTES);
  const priorRate = rateInWindow(readings, now - RECENT_WINDOW_MINUTES * 60 * 1000, PRIOR_WINDOW_MINUTES);
  const trendPhase = getTrendPhase(recentRate, priorRate);
  const consecutiveOutOfRange = countConsecutiveOutOfRange(readings);

  if (overallRate === null) return { severity: 'none', currentValue: current.sgv };

  const projected = projectGlucose(current.sgv, overallRate);
  const projectedExtended = projectGlucose(current.sgv, overallRate, EXTENDED_PROJECTION_MINUTES);
  const severity = classifySeverity({ currentValue: current.sgv, rate: overallRate, projected, projectedExtended });

  if (severity === 'none') {
    return { severity, rate: overallRate, recentRate, trendPhase, currentValue: current.sgv, projected, projectedExtended, consecutiveOutOfRange };
  }

  const notificationMessage = buildNotificationMessage(severity, current.sgv, overallRate, projected);

  const [pushResult, geminiResult] = await Promise.allSettled([
    sendPushNotification(notificationMessage),
    callGeminiForAnalysis({
      currentValue: current.sgv,
      rate: overallRate,
      trendPhase,
      severity,
      projected,
      recentReadings: readings.slice(-6)
    })
  ]);

  return {
    severity,
    fullScreenAlert: severity === 'red', // Android layer checks this to decide push vs. takeover
    rate: overallRate,
    recentRate,
    trendPhase,
    currentValue: current.sgv,
    projected,
    projectedExtended,
    consecutiveOutOfRange,
    notificationMessage,
    pushResult,
    geminiResult
  };
}

module.exports = {
  calculateRate,
  rateInWindow,
  getTrendPhase,
  classifySeverity,
  projectGlucose,
  countConsecutiveOutOfRange,
  buildNotificationMessage,
  processNewReading,
  PROJECTION_MINUTES,
  EXTENDED_PROJECTION_MINUTES,
  YELLOW_PROJECTED_LOW,
  YELLOW_PROJECTED_HIGH,
  RED_PROJECTED_LOW,
  RED_PROJECTED_HIGH
};