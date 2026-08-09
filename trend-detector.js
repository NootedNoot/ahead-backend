// trend-detector.js
// Call processNewReading() every time a new Nightscout reading lands (every ~5 min).
// Severity is now tiered: 'none' | 'yellow' | 'red'.
// Yellow = normal push. Red = full-screen intent / phone lock takeover territory.
// Everything under TUNING KNOBS is meant to get messed with. These are starting
// guesses - play with them against your real data for a few days and adjust.

// ---- TUNING KNOBS ----

// Projection windows
const PROJECTION_MINUTES = 15;
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

// Severity is primarily proximity-based: it keys off where glucose is PROJECTED
// to land. Rate is normally just context, but a sufficiently fast rate now also
// escalates to yellow on its own, regardless of projection - see
// YELLOW_RATE_FALLING/YELLOW_RATE_RISING below.
//   Yellow: projection approaching a caution zone, OR rate fast enough on its own.
//   Red:    projection crossing a real danger threshold.
// 2026-08-08: lowered low-side from 90 to 80 - owner reported it firing on a
// flat/stable ~90-94 (rate well within the +-1.0 FLAT band, see
// GlucoseTrendArrow.kt) with hours of no real change, just ordinary noise
// nudging the 15-min projection a point or two under 90. A fast real drop is
// still caught two other ways regardless of this constant: YELLOW_RATE_FALLING
// below (rate <= -1.5, independent of projection) and RED_PROJECTED_LOW (70,
// unchanged) once the decline is actually significant - this only narrows the
// slow/flat-proximity band, not the fast-drop path.
const YELLOW_PROJECTED_LOW = 80;
const YELLOW_PROJECTED_HIGH = 200;
const RED_PROJECTED_LOW = 70;
const RED_PROJECTED_HIGH = 250;

// Hard actual-value floor: at or below this, severity is RED no matter what the
// projection says (see classifySeverity). Raised from the clinical 54 cutoff to
// 60 so RED fires before glucose is already deep in the hole, not right at it.
const SEVERE_LOW_RED_FLOOR = 60;

// Rate-based yellow escalation: independent of projection. A drop/climb this
// fast deserves at least yellow right now even when both projections happen
// to land back in the safe band (e.g. a fast fall from a high starting
// point, like -2.3 mg/dL/min from 144, whose 15/30-min projections alone
// don't cross YELLOW_PROJECTED_LOW).
const YELLOW_RATE_FALLING = -1.5;
const YELLOW_RATE_RISING = 2.5;

// Default decay for RED's projection on a fast, still-accelerating RISE (not
// yet confirmed 'decelerating' by assessRateTrajectory). Without this,
// projectGlucose holds the rate flat for the whole window, so a genuinely
// fast rise overshoots real-world projections with zero curve. Deliberately
// one-sided: falling projections never get default decay here, only ever the
// trajectory-confirmed 'decelerating' decay above - underestimating a RED low
// is far more dangerous than underestimating a RED high, since a rise has a
// natural brake (insulin catching up) a fall does not.
const PROJECTION_DECAY_RATE_THRESHOLD = 2.0; // mg/dL/min - below this, hold flat as before
const DEFAULT_DECAY_PER_STEP = 0.3; // mg/dL/min eased off per 5-min step, mild default

const DEFAULT_TUNING = Object.freeze({
  yellowProjectedLow: YELLOW_PROJECTED_LOW,
  yellowProjectedHigh: YELLOW_PROJECTED_HIGH,
  redProjectedLow: RED_PROJECTED_LOW,
  redProjectedHigh: RED_PROJECTED_HIGH,
  extendedProjectionMinutes: EXTENDED_PROJECTION_MINUTES,
  // 2 intervals means a maximum of 3 readings. Keep the real-time rate
  // reactive: one interval disables smoothing, two applies the light average.
  smoothingIntervals: 2,
});

/**
 * Debug-only callers may attach tuning to /api/check-trend. Treat every input
 * as untrusted: invalid or implausible values fall back to shipped defaults,
 * and ordering is repaired so an accidental field edit cannot invert tiers.
 */
function resolveTuning(input) {
  const numberOr = (value, fallback, min, max) =>
    Number.isFinite(value) && value >= min && value <= max ? value : fallback;

  const yellowLow = numberOr(input?.yellowProjectedLow, DEFAULT_TUNING.yellowProjectedLow, 40, 180);
  const yellowHigh = numberOr(input?.yellowProjectedHigh, DEFAULT_TUNING.yellowProjectedHigh, 120, 350);
  const redLow = numberOr(input?.redProjectedLow, DEFAULT_TUNING.redProjectedLow, 40, 150);
  const redHigh = numberOr(input?.redProjectedHigh, DEFAULT_TUNING.redProjectedHigh, 150, 400);

  return {
    yellowProjectedLow: Math.max(yellowLow, redLow),
    yellowProjectedHigh: Math.min(yellowHigh, redHigh),
    redProjectedLow: Math.min(redLow, yellowLow),
    redProjectedHigh: Math.max(redHigh, yellowHigh),
    extendedProjectionMinutes: numberOr(
      input?.extendedProjectionMinutes,
      DEFAULT_TUNING.extendedProjectionMinutes,
      PROJECTION_MINUTES,
      60,
    ),
    smoothingIntervals: Math.round(numberOr(input?.smoothingIntervals, DEFAULT_TUNING.smoothingIntervals, 1, 2)),
  };
}

// How close together (and how similar in value) two readings have to be to
// be treated as the same underlying CGM sample rather than two real
// consecutive readings - mirrors ahead-rate-math's Kotlin collapseDuplicates
// exactly (see that module's golden-vectors/ for the shared spec both sides
// are tested against). Added 2026-08-08: ahead-android's on-device
// HealthConnectManager already had this protection after the real
// 2026-08-03 incident (two writer apps flooding Health Connect with
// near-duplicate records, sometimes sharing the exact same timestamp) - this
// backend had no equivalent, so the same class of glitch could still divide
// by a near-zero-second gap here and silently corrupt a severity decision or
// push notification, even though the on-device display had already been
// fixed. A real CGM never reports two different values within a few seconds
// of each other, so collapsing same-value readings inside a short window is
// safe - it can only ever merge duplicate writes, never two genuinely
// different consecutive samples.
const DUPLICATE_MERGE_WINDOW_SECONDS = 90;

/**
 * Collapses consecutive readings that look like the same underlying CGM
 * sample written by more than one source - see
 * DUPLICATE_MERGE_WINDOW_SECONDS above. Keeps the LATER of the two
 * timestamps (closer to "when this was actually learned"); sgv is identical
 * either way since they're treated as one sample. readings must already be
 * sorted oldest -> newest.
 */
function collapseDuplicateReadings(readings, mergeWindowSeconds = DUPLICATE_MERGE_WINDOW_SECONDS) {
  const mergeWindowMs = mergeWindowSeconds * 1000;
  const result = [];
  for (const reading of readings) {
    const last = result[result.length - 1];
    const isDuplicate = last && last.sgv === reading.sgv && Math.abs(reading.date - last.date) <= mergeWindowMs;
    if (isDuplicate) {
      result[result.length - 1] = reading;
    } else {
      result.push(reading);
    }
  }
  return result;
}

/**
 * Rate of change (mg/dL/min) using the oldest and newest reading inside a
 * window ending at windowEndTime, going back windowMinutes.
 * readings must be sorted oldest -> newest.
 */
function rateInWindow(readings, windowEndTime, windowMinutes) {
  const cutoff = windowEndTime - windowMinutes * 60 * 1000;
  const inWindow = collapseDuplicateReadings(readings.filter(r => r.date > cutoff && r.date <= windowEndTime));

  if (inWindow.length < 2) return null;

  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  const minutesElapsed = (last.date - first.date) / 60000;

  if (minutesElapsed === 0) return null;

  return (last.sgv - first.sgv) / minutesElapsed;
}

/** Slope (mg/dL/min) between two readings, or null if their timestamps collide. */
function pointToPointRate(from, to) {
  const minutes = (to.date - from.date) / 60000;
  if (minutes <= 0) return null;
  return (to.sgv - from.sgv) / minutes;
}

/**
 * The overall rate that drives the projection - deliberately reactive to the
 * LATEST movement, not a long windowed average.
 *
 * Why not a windowed slope: this used to be an oldest-to-newest slope over a
 * 20-min window, which carries momentum from stale readings. In real testing a
 * value that had just dropped 227->220 still reported +0.6/min (because the
 * window's older end was low), so the projection extrapolated a *rise* off a
 * value that was actively falling. Projection-based severity is only as good as
 * the rate is in the moment, so we key off the most recent interval instead.
 *
 * Smoothing is intentionally light - at most the two most recent intervals
 * (3 points) are averaged to damp single-reading noise. Crucially, a direction
 * reversal in the newest interval OVERRIDES that smoothing within one cycle:
 * the moment the latest reading turns the other way, we trust it alone rather
 * than let an older upward interval mask a fresh drop (or vice versa).
 */
function calculateRate(readings, smoothingIntervals = DEFAULT_TUNING.smoothingIntervals) {
  // Dedupe first, not just as a precondition callers have to remember - see
  // DUPLICATE_MERGE_WINDOW_SECONDS's doc. This makes calculateRate safe to
  // call directly from anywhere (tests, recentRates' slicing, future
  // callers) without depending on the caller having pre-cleaned its input,
  // matching ahead-rate-math's Kotlin ratePerMinute doing the same.
  const deduped = collapseDuplicateReadings(readings);
  if (deduped.length < 2) return null;

  const latest = deduped[deduped.length - 1];
  const prev = deduped[deduped.length - 2];
  const recentRate = pointToPointRate(prev, latest);
  if (recentRate === null) return null;

  // A one-interval tuning explicitly opts out of smoothing. Otherwise, not
  // enough history to smooth means the newest interval is all we have.
  if (smoothingIntervals < 2 || deduped.length < 3) return recentRate;

  const prev2 = deduped[deduped.length - 3];
  const priorRate = pointToPointRate(prev2, prev);
  if (priorRate === null) return recentRate;

  // Reversal: the latest move flipped direction vs the interval before it.
  // React immediately - don't average away a fresh turn.
  const reversed =
    Math.sign(recentRate) !== Math.sign(priorRate) && recentRate !== 0 && priorRate !== 0;
  if (reversed) return recentRate;

  // Same direction: light 2-interval average to take the edge off jitter.
  return (recentRate + priorRate) / 2;
}

function projectGlucose(currentValue, rate, minutesAhead = PROJECTION_MINUTES) {
  return Math.round(currentValue + rate * minutesAhead);
}

// ---- RED-projection confirmation ----
// One noisy rate calc (a CGM compression spike, a lone outlier) shouldn't be
// enough to fire a full RED takeover off a projection that assumes it holds
// flat. These three helpers let the RED decision consult the last few rate
// calcs first. YELLOW logic is untouched - this only gates RED.

/** The rate as it would have been calculated at each of the last [count]
 *  readings, oldest -> newest. Recomputes calculateRate on progressively
 *  shorter slices so each entry reflects what we'd have reported at that point. */
function recentRates(readings, count, smoothingIntervals) {
  const rates = [];
  for (let k = 0; k < count; k++) {
    const end = readings.length - k;
    if (end < 2) break;
    const r = calculateRate(readings.slice(0, end), smoothingIntervals);
    if (r === null) break;
    rates.unshift(r);
  }
  return rates;
}

/**
 * Classifies the recent rate trajectory:
 *  - 'consistent'   : same direction, no wild magnitude swings -> trust the flat
 *                     projection and let RED fire as normal.
 *  - 'decelerating' : same direction but each rate is gently easing off -> decay
 *                     the projection instead of holding the rate flat.
 *  - 'noisy'        : a sign flip or a >50% jump between consecutive rates -> a
 *                     single reading shouldn't decide RED; wait for confirmation.
 * With fewer than 3 rates we can't confirm, so we default to 'consistent' - RED
 * suppression must never make us MISS a genuine fast climb on thin history.
 */
function assessRateTrajectory(rates) {
  if (rates.length < 3) return { kind: 'consistent', avgDeltaPerStep: 0 };

  let signChange = false;
  let bigSwing = false;
  for (let i = 1; i < rates.length; i++) {
    const prev = rates[i - 1];
    const cur = rates[i];
    if (Math.sign(prev) !== 0 && Math.sign(cur) !== 0 && Math.sign(prev) !== Math.sign(cur)) signChange = true;
    const base = Math.abs(prev);
    if (base === 0 ? cur !== 0 : Math.abs(cur - prev) / base > 0.5) bigSwing = true;
  }
  if (signChange || bigSwing) return { kind: 'noisy', avgDeltaPerStep: 0 };

  const decreasing = rates.every((r, i) => i === 0 || Math.abs(r) < Math.abs(rates[i - 1]));
  if (decreasing) {
    let sum = 0;
    for (let i = 1; i < rates.length; i++) sum += rates[i] - rates[i - 1];
    return { kind: 'decelerating', avgDeltaPerStep: sum / (rates.length - 1) };
  }
  return { kind: 'consistent', avgDeltaPerStep: 0 };
}

/**
 * Projection that decays the rate toward zero by [avgDeltaPerStep] each step,
 * instead of holding it flat. Used when the recent trajectory is decelerating:
 * a climb that's easing off shouldn't project as if the current peak rate holds
 * for the whole window. The rate is clamped at zero (it levels off, never
 * reverses) so the decay can only cool the projection, never invert it.
 */
function projectWithDecay(currentValue, currentRate, avgDeltaPerStep, minutes, stepMinutes = 5) {
  let value = currentValue;
  let r = currentRate;
  let remaining = minutes;
  while (remaining > 0) {
    const step = Math.min(stepMinutes, remaining);
    value += r * step;
    if (r > 0) r = Math.max(0, r + avgDeltaPerStep);
    else if (r < 0) r = Math.min(0, r + avgDeltaPerStep);
    remaining -= step;
  }
  return Math.round(value);
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
 * Proximity-first: severity is primarily a function of where glucose is
 * PROJECTED to land. Velocity escalates it two ways: directly, when the rate
 * itself crosses YELLOW_RATE_FALLING/YELLOW_RATE_RISING (fast enough to matter
 * regardless of where the projection lands); and through the extended-horizon
 * nudge below, which is direction-aware (extrapolating the real slope further
 * out) - so a value that's merely high-but-falling toward safe, at an ordinary
 * pace, stays 'none' instead of firing a pointless warning.
 */
function classifySeverity({ currentValue, rate, projected, projectedExtended, redProjected, allowRed = true, tuning }) {
  const params = resolveTuning(tuning);

  // HARD FLOOR - actual value, not projection. A genuinely low reading is RED
  // right now regardless of where the trend/projection thinks it's heading: a
  // rebound in progress (e.g. 46 climbing after treatment) is still 46 in the
  // moment, and 46/50/54 are clinically urgent. This is deliberately BEFORE the
  // allowRed gate, so trajectory dampening can never soften an actual severe low.
  // 54 mg/dL is the standard clinical "clinically significant hypoglycemia" cutoff.
  if (currentValue <= SEVERE_LOW_RED_FLOOR) return 'red';

  // The RED decision uses [redProjected] when supplied (a decay-dampened
  // projection from the trajectory check) and falls back to the flat 15-min
  // projection otherwise. [allowRed] is false when the recent rate trajectory
  // is too noisy to trust a single reading with a RED escalation.
  const redProj = typeof redProjected === 'number' ? redProjected : projected;
  // RED: the projection crosses a real danger threshold, OR we're already in a
  // danger zone and still moving deeper into it (direction guard - a value
  // already past the threshold but heading back toward safe doesn't count).
  if (allowRed) {
    const projectedRed = redProj <= params.redProjectedLow || redProj >= params.redProjectedHigh;
    const worseningInDanger =
      (currentValue <= params.redProjectedLow && rate < 0) ||
      (currentValue >= params.redProjectedHigh && rate > 0);
    if (projectedRed || worseningInDanger) return 'red';
  }

  // YELLOW: a sufficiently fast rate escalates on its own, regardless of where
  // the projection lands - see YELLOW_RATE_FALLING/RISING above.
  if (rate <= YELLOW_RATE_FALLING || rate >= YELLOW_RATE_RISING) return 'yellow';

  // YELLOW: currently below the ordinary low line right now (61-70; 60 and
  // under is already RED via the hard floor above), independent of
  // yellowProjectedLow. 2026-08-08: yellowProjectedLow was lowered from 90 to
  // 80 so a comfortably-normal, flat ~90-94 stops tripping yellow on noise -
  // but a real recovering low (e.g. currentValue 65, rising, projected 85)
  // must not go silent just because its projection now clears the
  // proximity line faster than it clears the actual danger band. Being at
  // 61-70 is still a real low in the moment, rising or not.
  if (currentValue <= params.redProjectedLow) return 'yellow';

  // YELLOW: the projection is approaching a caution zone, OR the current slope
  // extended to the longer horizon would reach red territory (early warning on a
  // genuinely fast move - the extended projection encodes direction, so it can't
  // fire on drift heading toward safe).
  const projectedYellow = projected <= params.yellowProjectedLow || projected >= params.yellowProjectedHigh;
  const extendedReachesRed =
    projectedExtended <= params.redProjectedLow || projectedExtended >= params.redProjectedHigh;
  if (projectedYellow || extendedReachesRed) return 'yellow';

  return 'none';
}

function buildNotificationMessage(severity, currentValue, rate, projected, projectedExtended, extendedMinutes = EXTENDED_PROJECTION_MINUTES) {
  const direction = rate > 0 ? 'rising' : 'falling';
  const sign = rate > 0 ? '+' : '';
  const rateStr = `${sign}${rate.toFixed(1)}`;
  // Show BOTH projection windows explicitly - the tier can be decided off the
  // 15-min or the extended window, so the alert text must never imply only one.
  const base = `${currentValue} ${direction} ${rateStr}mg/dL a min. ` +
    `Expected ${projected} in ${PROJECTION_MINUTES} min · ${projectedExtended} in ${extendedMinutes} min.`;

  if (severity === 'red') {
    return `🔴 URGENT: ${base} Check now.`;
  }
  return `${base} Consider checking in.`;
}

/**
 * Main entry point. Call this after every new reading is stored.
 * readings: full array, sorted oldest -> newest, each { sgv, date }
 */
async function processNewReading(readings, { sendPushNotification, tuning }) {
  if (!readings || readings.length < 2) return { severity: 'none' };

  const current = readings[readings.length - 1];
  const now = current.date;

  const params = resolveTuning(tuning);
  const overallRate = calculateRate(readings, params.smoothingIntervals);
  const recentRate = rateInWindow(readings, now, RECENT_WINDOW_MINUTES);
  const priorRate = rateInWindow(readings, now - RECENT_WINDOW_MINUTES * 60 * 1000, PRIOR_WINDOW_MINUTES);
  const trendPhase = getTrendPhase(recentRate, priorRate);
  const consecutiveOutOfRange = countConsecutiveOutOfRange(readings);

  if (overallRate === null) return { severity: 'none', currentValue: current.sgv };

  const projected = projectGlucose(current.sgv, overallRate);
  const projectedExtended = projectGlucose(current.sgv, overallRate, params.extendedProjectionMinutes);

  // Confirm the RED escalation against the last few rate calcs before trusting
  // the flat projection (see the RED-projection confirmation helpers above).
  const rateHistory = recentRates(readings, 3, params.smoothingIntervals);
  const trajectory = assessRateTrajectory(rateHistory);
  // Decay-by-default only applies to fast RISING rates that aren't already
  // confirmed decelerating. Falling rates never get default decay - they keep
  // the flat, worst-case projection regardless of speed, since an underestimated
  // low is more dangerous than an underestimated high.
  const isFastRising = overallRate >= PROJECTION_DECAY_RATE_THRESHOLD;
  const decayPerStep = trajectory.kind === 'decelerating'
    ? trajectory.avgDeltaPerStep
    : (isFastRising ? -DEFAULT_DECAY_PER_STEP : 0);

  const redProjected = decayPerStep !== 0
    ? projectWithDecay(current.sgv, overallRate, decayPerStep, PROJECTION_MINUTES)
    : projected;
  const allowRed = trajectory.kind !== 'noisy';

  const severity = classifySeverity({
    currentValue: current.sgv, rate: overallRate, projected, projectedExtended,
    redProjected, allowRed, tuning: params,
  });

  if (severity === 'none') {
    return { severity, rate: overallRate, recentRate, trendPhase, currentValue: current.sgv, projected, projectedExtended, redProjected, rateTrajectory: trajectory.kind, consecutiveOutOfRange, tuning: params };
  }

  const notificationMessage = buildNotificationMessage(severity, current.sgv, overallRate, projected, projectedExtended, params.extendedProjectionMinutes);

  const pushResult = await sendPushNotification(notificationMessage).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason })
  );

  return {
    severity,
    fullScreenAlert: severity === 'red', // Android layer checks this to decide push vs. takeover
    rate: overallRate,
    recentRate,
    trendPhase,
    currentValue: current.sgv,
    projected,
    projectedExtended,
    redProjected,
    rateTrajectory: trajectory.kind,
    consecutiveOutOfRange,
    tuning: params,
    notificationMessage,
    pushResult
  };
}

module.exports = {
  calculateRate,
  pointToPointRate,
  collapseDuplicateReadings,
  DUPLICATE_MERGE_WINDOW_SECONDS,
  recentRates,
  assessRateTrajectory,
  projectWithDecay,
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
  YELLOW_RATE_FALLING,
  YELLOW_RATE_RISING,
  RED_PROJECTED_HIGH,
  SEVERE_LOW_RED_FLOOR
  ,DEFAULT_TUNING
  ,resolveTuning
};
