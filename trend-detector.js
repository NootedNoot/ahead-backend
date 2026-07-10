// trend-detector.js
// Call processNewReading() every time a new Nightscout reading lands (every ~5 min).
// Severity is now tiered: 'none' | 'yellow' | 'red'.
// Yellow = normal push. Red = full-screen intent / phone lock takeover territory.
// Everything under TUNING KNOBS is meant to get messed with. These are starting
// guesses - play with them against your real data for a few days and adjust.

// ---- TUNING KNOBS ----

// Rate thresholds (mg/dL/min)
const YELLOW_RISE_THRESHOLD = 1.5;
const YELLOW_FALL_THRESHOLD = -1.5;
const RED_RISE_THRESHOLD = 2.5;
const RED_FALL_THRESHOLD = -2.5;

// Projection + lookback windows
const PROJECTION_MINUTES = 15;
const LOOKBACK_MINUTES = 20; // feeds the overall rate used for the projection

// Two-window comparison - this is what detects accelerating vs decelerating.
// "Recent" is compared against the window right before it.
const RECENT_WINDOW_MINUTES = 10;
const PRIOR_WINDOW_MINUTES = 10;
const TREND_PHASE_NOISE_FLOOR = 0.3; // mg/dL/min - smaller diffs than this = just noise, not a real phase change

// Sustained out-of-range (flat, not fast-moving, but stuck)
const OUT_OF_RANGE_LOW = 80;
const OUT_OF_RANGE_HIGH = 160;
const CONSECUTIVE_OUT_OF_RANGE_TRIGGER = 2; // ~15 min at 5-min readings

// Projected-value danger zone. If the 15-min projection lands here, that alone
// can push severity toward red, since "about to be actually dangerous" matters
// more than what the rate looked like a minute ago.
const CRITICAL_PROJECTED_LOW = 70;
const CRITICAL_PROJECTED_HIGH = 250;

// Projected-value warning zone (yellow). A slow drift can project out of range
// long before the rate trips the yellow rate threshold - without this band a
// steady -0.8/min glide goes none -> red with no warning tier in between.
// LOW aligns with OUT_OF_RANGE_LOW so "projected to leave range" and "sitting
// out of range" agree on where range is. HIGH is a starting guess - tune it.
const WARNING_PROJECTED_LOW = 80;
const WARNING_PROJECTED_HIGH = 200;

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
 */
function classifySeverity({ recentRate, trendPhase, projected, consecutiveOutOfRange }) {
  const isRedRate =
    recentRate !== null && (recentRate >= RED_RISE_THRESHOLD || recentRate <= RED_FALL_THRESHOLD);
  const isYellowRate =
    recentRate !== null && (recentRate >= YELLOW_RISE_THRESHOLD || recentRate <= YELLOW_FALL_THRESHOLD);
  const projectedCritical = projected <= CRITICAL_PROJECTED_LOW || projected >= CRITICAL_PROJECTED_HIGH;
  const projectedWarning = projected <= WARNING_PROJECTED_LOW || projected >= WARNING_PROJECTED_HIGH;
  const sustainedOutOfRange = consecutiveOutOfRange >= CONSECUTIVE_OUT_OF_RANGE_TRIGGER;

  if (isRedRate || projectedCritical) {
    // Fast and/or heading somewhere dangerous - BUT if it's actively
    // correcting itself, don't cry wolf at the max volume.
    if (trendPhase === 'decelerating') return 'yellow';
    return 'red';
  }

  if (isYellowRate || sustainedOutOfRange || projectedWarning) return 'yellow';

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
  const severity = classifySeverity({ recentRate, trendPhase, projected, consecutiveOutOfRange });

  if (severity === 'none') {
    return { severity, rate: overallRate, recentRate, trendPhase, currentValue: current.sgv, projected };
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
  YELLOW_RISE_THRESHOLD,
  YELLOW_FALL_THRESHOLD,
  RED_RISE_THRESHOLD,
  RED_FALL_THRESHOLD,
  PROJECTION_MINUTES,
  WARNING_PROJECTED_LOW,
  WARNING_PROJECTED_HIGH
};