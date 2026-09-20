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

// 2026-08-28: pulled out of inline literals during a fragmentation audit -
// these four were previously bare numbers (140, 160, 240, 40*60*1000)
// scattered through classifySeverity/processNewReading with no name, which
// made it impossible for the shared golden-vectors constants-parity test
// (ahead-rate-math/golden-vectors/severity-thresholds.json) to check them
// against SeverityEngine.kt's equivalents. Values unchanged - naming only.
const VULNERABLE_DROP_CEILING_MGDL = 140;
const VULNERABLE_RISE_FLOOR_MGDL = 160;
const RECOVERY_REBOUND_CEILING_MGDL = 240;
const RECOVERING_FROM_LOW_TRIGGER_MGDL = 80;
const POST_HYPO_RECOVERY_GRACE_WINDOW_MS = 40 * 60 * 1000;

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

// 2026-09-20: the merge used to require the two values to be EXACTLY equal, which missed the
// likeliest real shape of a double write - two writers rounding the same mmol/L sample to mg/dL
// and landing one apart. Two points 2 seconds apart differing by 1 then survived as "real
// consecutive samples" and the slope divided by that 2-second gap: measured 15 mg/dL/min here
// (30 on the Kotlin side, which is unsmoothed) out of nothing. A real CGM cannot move 2 mg/dL
// meaningfully inside 90 seconds, so this still only ever merges duplicate writes.
// Mirrors ahead-rate-math RateMath.DUPLICATE_MERGE_VALUE_TOLERANCE_MGDL.
const DUPLICATE_MERGE_VALUE_TOLERANCE_MGDL = 2;

// Longest gap that can still yield a trustworthy rate. Mirrors RateMath.MAX_RATE_INTERVAL_MINUTES.
// Before this, the first reading after a blackout was divided by the whole blackout - a real fall
// from 124 to 72 across two hours reported as -0.43 mg/dL/min. 20 minutes tolerates ordinary
// 5-minute-cadence jitter (up to three missed samples) without inventing a rate across an outage.
const MAX_RATE_INTERVAL_MINUTES = 20;

// How much steeper the newest interval may be than its predecessor and still count as a real
// acceleration rather than a single-sample glitch. Mirrors RateMath.MAX_ESCALATION_RATIO.
const MAX_ESCALATION_RATIO = 3.0;

// Projections are clamped into this range - see projectGlucose.
const MIN_PLAUSIBLE_MGDL = 0;
const MAX_PLAUSIBLE_MGDL = 600;

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
    const isDuplicate = last &&
      Math.abs(last.sgv - reading.sgv) <= DUPLICATE_MERGE_VALUE_TOLERANCE_MGDL &&
      Math.abs(reading.date - last.date) <= mergeWindowMs;
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
  // A gap this long means we do not know what happened in between - see
  // MAX_RATE_INTERVAL_MINUTES. "Unknown" is safer than a diluted number that looks precise.
  if (minutes > MAX_RATE_INTERVAL_MINUTES) return null;
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

/**
 * Clamps a projection into the physiologically possible range. 2026-09-20: straight-line
 * extrapolation of a steep rate used to print impossible numbers - a 30-min projection of
 * -29 mg/dL - which reached the notification text. Clamping changes no severity decision
 * (every threshold sits inside this range), it only stops the app saying something impossible.
 * Mirrors ahead-rate-math RateMath.clampProjection.
 */
function clampProjection(value) {
  return Math.min(MAX_PLAUSIBLE_MGDL, Math.max(MIN_PLAUSIBLE_MGDL, value));
}

function projectGlucose(currentValue, rate, minutesAhead = PROJECTION_MINUTES) {
  return clampProjection(Math.round(currentValue + rate * minutesAhead));
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
 *  - 'consistent'   : the two most recent rates agree (same direction, no wild
 *                     swing between just the two of them) -> trust the flat
 *                     projection and let RED fire as normal.
 *  - 'decelerating' : same direction across the whole window and each rate is
 *                     gently easing off -> decay the projection instead of
 *                     holding the rate flat.
 *  - 'noisy'        : the LATEST rate disagrees with the one right before it -
 *                     a sign flip or a >50% jump between just those two -> the
 *                     newest reading alone shouldn't decide RED; wait for the
 *                     next one to confirm it.
 * With fewer than 3 rates we can't confirm, so we default to 'consistent' - RED
 * suppression must never make us MISS a genuine fast climb on thin history.
 *
 * 2026-08-11: deliberately scoped to only the most recent pair, not every
 * adjacent pair in the window. It used to be that ANY sign flip or big swing
 * anywhere in the 3-rate window - even one two readings back that the latest
 * two have since agreed on - forced 'noisy' and vetoed RED for the whole
 * window. Real incident: rates [+2.0, -3.4, -4.1] (a value that had been
 * rising, then turned hard into a real, accelerating fall) got stuck at
 * 'noisy' purely because of the OLD +2.0->-3.4 flip, even though the two most
 * recent rates fully agreed with each other and the fall kept getting worse -
 * this held a currentValue=89, projected=28 case to YELLOW when it should
 * have been RED. A reversal that's already been confirmed twice in a row
 * isn't noise, it's exactly what a real crash looks like at its onset. The
 * 'decelerating' path's own decreasing-magnitude check below is untouched and
 * still requires the WHOLE window to agree before easing a projection -
 * this change only makes it easier to trust a genuinely confirmed escalation,
 * never easier to trust an optimistic deceleration.
 */
function assessRateTrajectory(rates) {
  if (rates.length < 3) return { kind: 'consistent', avgDeltaPerStep: 0 };

  const prev = rates[rates.length - 2];
  const latest = rates[rates.length - 1];
  const signChange = Math.sign(prev) !== 0 && Math.sign(latest) !== 0 && Math.sign(prev) !== Math.sign(latest);
  const base = Math.abs(prev);
  const bigSwing = base === 0 ? latest !== 0 : Math.abs(latest - prev) / base > 0.5;

  // 2026-09-20: a CONFIRMED, PROPORTIONATE ACCELERATION is not noise - it is what the onset of a
  // real crash looks like, and it was the one shape that could never fire RED. Every interval in
  // the window pointing the same way, each strictly steeper than the last, is three readings
  // agreeing that this is getting worse; the >50% bigSwing rule fired on exactly that and vetoed
  // the escalation. Measured before this fix: 85 mg/dL reached via -1.2, -2.4, -3.8 scored YELLOW
  // while the identical value and rate reached steadily scored RED, both printing a projection
  // of 28. MAX_ESCALATION_RATIO is what still separates this from a single-sample glitch: a
  // dropout arrives as a wild outlier against a flat run (-0.2, -0.3, -5.0 is a 16x step), which
  // stays noisy and still cannot drive RED. Mirrors RateMath.assessRateTrajectory.
  const monotonicEscalation =
    rates.every((r) => Math.sign(r) === Math.sign(rates[0]) && r !== 0) &&
    rates.every((r, i) => i === 0 || Math.abs(r) > Math.abs(rates[i - 1])) &&
    base > 0 && Math.abs(latest) <= base * MAX_ESCALATION_RATIO;
  if ((signChange || bigSwing) && !monotonicEscalation) return { kind: 'noisy', avgDeltaPerStep: 0 };

  const sameDirection = rates.every((r) => Math.sign(r) === Math.sign(rates[0]) && r !== 0);
  const decreasing = sameDirection && rates.every((r, i) => i === 0 || Math.abs(r) < Math.abs(rates[i - 1]));
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
    if (r > 0) r = Math.max(0, Math.min(r, r + avgDeltaPerStep));
    else if (r < 0) r = Math.min(0, Math.max(r, r + avgDeltaPerStep));
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
function classifySeverity({ currentValue, rate, projected, projectedExtended, redProjected, allowRed = true, recoveringFromLow = false, tuning }) {
  const params = resolveTuning(tuning);

  // HARD FLOOR - actual value, not projection. A genuinely low reading is RED
  // right now regardless of where the trend/projection thinks it's heading: a
  // rebound in progress (e.g. 46 climbing after treatment) is still 46 in the
  // moment, and 46/50/54 are clinically urgent. This is deliberately BEFORE the
  // allowRed gate, so trajectory dampening can never soften an actual severe low.
  // 54 mg/dL is the standard clinical "clinically significant hypoglycemia" cutoff.
  if (currentValue <= SEVERE_LOW_RED_FLOOR) return 'red';

  // POST-HYPO RECOVERY GRACE WINDOW:
  // When recovering from a treated low (<= RECOVERING_FROM_LOW_TRIGGER_MGDL in
  // the past POST_HYPO_RECOVERY_GRACE_WINDOW_MS) and climbing, fast positive
  // rates (+2.5, +3.5) and expected rebound bumps under RECOVERY_REBOUND_CEILING_MGDL
  // stay SILENT.
  // 2026-09-20 - THE SILENT LOW. recoveringFromLow is derived in processNewReading as "some
  // reading <= RECOVERING_FROM_LOW_TRIGGER_MGDL in the last 40 minutes" - and the CURRENT reading
  // counts toward that. So every reading at or under 80 flagged itself as "recovering", and this
  // branch then returned 'none' for ANY positive rate. One mg/dL of sensor noise silenced a real
  // low: verified end-to-end through processNewReading, a run of 78 -> 74 -> 70 -> 66 -> 67 scored
  // 'none' and sent no push. The grace exists for "treated a low, now climbing back through
  // normal", which is only true once the value is clear of the low band; while still inside it,
  // fall through to ordinary tiering. Mirrors SeverityEngine.kt's identical guard.
  const clearOfLowBand = currentValue > RECOVERING_FROM_LOW_TRIGGER_MGDL;
  if (recoveringFromLow && clearOfLowBand && rate > 0 && currentValue < RECOVERY_REBOUND_CEILING_MGDL) {
    if (projected >= params.redProjectedHigh || currentValue >= RECOVERY_REBOUND_CEILING_MGDL) {
      return 'yellow';
    }
    return 'none';
  }

  // The RED decision uses [redProjected] when supplied (a decay-dampened
  // projection from the trajectory check) and falls back to the flat 15-min
  // projection otherwise. [allowRed] is false when the recent rate trajectory
  // is too noisy to trust a single reading with a RED escalation.
  const redProj = typeof redProjected === 'number' ? redProjected : projected;
  // RED: the projection crosses a real danger threshold, OR we're already in a
  // danger zone and still moving deeper into it (direction guard - a value
  // already past the threshold but heading back toward safe doesn't count).
  //
  // 2026-09-20 note on parity: SeverityEngine.kt splits this gate in two, because on-device it
  // carries a SECOND suppressor this file has no equivalent of - RateConsensus's rate-agreement
  // check - and that one must never silence a low. Here [allowRed] is only ever the noisy-
  // trajectory veto, which is still honoured on both sides, so the split would be a no-op. What
  // actually fixed the accelerating-crash miss on this side is assessRateTrajectory above no
  // longer calling a confirmed, proportionate acceleration "noisy" in the first place.
  const lowSideRed =
    redProj <= params.redProjectedLow || (currentValue <= params.redProjectedLow && rate < 0);
  const highSideRed =
    redProj >= params.redProjectedHigh || (currentValue >= params.redProjectedHigh && rate > 0);
  if (allowRed && (lowSideRed || highSideRed)) return 'red';

  // YELLOW: a sufficiently fast rate escalates when in a vulnerable range or heading toward danger.
  // Gated so a fast fall from a high (e.g. 180 -> 120) doesn't fire a false alarm when the 15m projection is safe.
  const fastDrop = rate <= YELLOW_RATE_FALLING && (currentValue <= VULNERABLE_DROP_CEILING_MGDL || projected <= params.yellowProjectedLow);
  const fastRise = rate >= YELLOW_RATE_RISING && (currentValue >= VULNERABLE_RISE_FLOOR_MGDL || projected >= params.yellowProjectedHigh);
  if (fastDrop || fastRise) return 'yellow';

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
  // rate === null means the slope could not be computed at all (one reading, colliding
  // timestamps, or - since 2026-09-20 - a gap too long to measure across). Say so rather than
  // printing a confident "falling 0.0", which is what a null used to render as.
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    const unknown = `${currentValue} mg/dL, trend unknown (not enough recent readings).`;
    return severity === 'red' ? `🔴 URGENT: ${unknown} Check now.` : `${unknown} Consider checking in.`;
  }
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

  // 2026-09-20: an unknown rate used to return 'none' outright, which meant ANY value at all -
  // 45 mg/dL included - scored silent whenever the slope could not be computed. That was already
  // reachable (a single deduped reading, colliding timestamps) and the new max-gap rule widens it
  // to "first reading after a blackout", so it has to be handled rather than short-circuited.
  // An unknown rate is not evidence of safety: fall through with a flat (rate-0) projection so
  // the value-based checks - the <=60 hard floor, the <=70 band, the proximity bands - all still
  // run. `rate: null` is preserved in the result and in the alert text, which says "trend
  // unknown" rather than inventing a confident 0.0.
  const rateKnown = overallRate !== null;
  const effectiveRate = rateKnown ? overallRate : 0;

  const projected = projectGlucose(current.sgv, effectiveRate);
  const projectedExtended = projectGlucose(current.sgv, effectiveRate, params.extendedProjectionMinutes);

  // Confirm the RED escalation against the last few rate calcs before trusting
  // the flat projection (see the RED-projection confirmation helpers above).
  const rateHistory = recentRates(readings, 3, params.smoothingIntervals);
  const trajectory = assessRateTrajectory(rateHistory);
  // Decay-by-default only applies to fast RISING rates that aren't already
  // confirmed decelerating. Falling rates never get default decay - they keep
  // the flat, worst-case projection regardless of speed, since an underestimated
  // low is more dangerous than an underestimated high.
  const isFastRising = effectiveRate >= PROJECTION_DECAY_RATE_THRESHOLD;
  const decayPerStep = trajectory.kind === 'decelerating'
    ? trajectory.avgDeltaPerStep
    : (isFastRising ? -DEFAULT_DECAY_PER_STEP : 0);

  const redProjected = decayPerStep !== 0
    ? projectWithDecay(current.sgv, effectiveRate, decayPerStep, PROJECTION_MINUTES)
    : projected;
  const allowRed = trajectory.kind !== 'noisy';

  const currentTime = current.date ? new Date(current.date).getTime() : Date.now();
  const recoveringFromLow = readings.some(r => {
    const t = r.date ? new Date(r.date).getTime() : currentTime;
    return (currentTime - t <= POST_HYPO_RECOVERY_GRACE_WINDOW_MS) && (r.sgv <= RECOVERING_FROM_LOW_TRIGGER_MGDL);
  });

  const severity = classifySeverity({
    currentValue: current.sgv, rate: effectiveRate, projected, projectedExtended,
    redProjected, allowRed, recoveringFromLow, tuning: params,
  });

  if (severity === 'none') {
    return { severity, rate: overallRate, rateKnown, recentRate, trendPhase, currentValue: current.sgv, projected, projectedExtended, redProjected, rateTrajectory: trajectory.kind, consecutiveOutOfRange, tuning: params };
  }

  const notificationMessage = buildNotificationMessage(severity, current.sgv, overallRate, projected, projectedExtended, params.extendedProjectionMinutes);

  // Gemini-backed analysis used to run alongside the push send here
  // (Promise.allSettled with a second callGeminiForAnalysis call) - removed
  // 2026-08-27, needs a real rework rather than shipping half-done (see
  // server.js's /analyze doc comment for the matching removal there).
  const pushResult = await sendPushNotification(notificationMessage);

  return {
    severity,
    rateKnown,
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
    pushResult,
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
  SEVERE_LOW_RED_FLOOR,
  VULNERABLE_DROP_CEILING_MGDL,
  VULNERABLE_RISE_FLOOR_MGDL,
  RECOVERY_REBOUND_CEILING_MGDL,
  RECOVERING_FROM_LOW_TRIGGER_MGDL,
  POST_HYPO_RECOVERY_GRACE_WINDOW_MS
  ,DEFAULT_TUNING
  ,resolveTuning
};
