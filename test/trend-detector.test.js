// Run with: npm test  (node --test)
// Zero-dependency tests via node:test. Guards the proximity-first severity
// tiering: severity keys off where glucose is PROJECTED to land, not how fast
// it's moving. Rate only escalates through the extended-horizon nudge, which is
// direction-aware, so mildly-high-but-falling values don't fire noise.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifySeverity,
  processNewReading,
  calculateRate,
  assessRateTrajectory,
  projectWithDecay,
  buildNotificationMessage,
  SEVERE_LOW_RED_FLOOR,
} = require('../trend-detector.js');

// ---- severe-low hard floor (actual value, not projection) ----

test('46 rebounding upward is still RED (actual-value floor beats projection)', () => {
  // Tonight's real case: 46 climbing after treatment. Projection is in-range and
  // rising, which pre-floor scored YELLOW - but 46 right now is urgent.
  assert.equal(
    classifySeverity({ currentValue: 46, rate: 2.0, projected: 76, projectedExtended: 90 }),
    'red',
  );
});

test('the floor overrides even a noisy-trajectory RED suppression', () => {
  assert.equal(
    classifySeverity({ currentValue: 50, rate: 0, projected: 60, projectedExtended: 65, allowRed: false }),
    'red',
  );
});

test('54 (the floor boundary) is RED; above the floor, projection decides', () => {
  assert.equal(SEVERE_LOW_RED_FLOOR, 54);
  // 54: floored to RED even with a benign in-range projection.
  assert.equal(classifySeverity({ currentValue: 54, rate: 0.5, projected: 88, projectedExtended: 92 }), 'red');
  // 55: above the floor, so the projection decides. 88 is yellow-band, not red.
  assert.equal(classifySeverity({ currentValue: 55, rate: 0.5, projected: 88, projectedExtended: 92 }), 'yellow');
  // NOTE: 57 (from tonight's report) is ABOVE the 54 floor, so it is NOT forced
  // RED by this rule - it's decided by its projection. Flagged for the user.
});

// ---- RED-projection confirmation (trajectory of the last 3 rate calcs) ----

test('trajectory: steady same-direction climb is consistent', () => {
  assert.equal(assessRateTrajectory([2.2, 2.5, 2.8]).kind, 'consistent');
});

test('trajectory: gently easing climb is decelerating with a negative delta', () => {
  const t = assessRateTrajectory([2.8, 2.5, 2.2]);
  assert.equal(t.kind, 'decelerating');
  assert.ok(t.avgDeltaPerStep < 0);
});

test('trajectory: a sign flip is noisy', () => {
  assert.equal(assessRateTrajectory([2.0, -1.0, 1.5]).kind, 'noisy');
});

test('trajectory: a >50% magnitude swing is noisy even if monotonic', () => {
  assert.equal(assessRateTrajectory([3.0, 1.0, 0.8]).kind, 'noisy');
});

test('trajectory: fewer than 3 rates defaults to consistent (never suppress RED on thin history)', () => {
  assert.equal(assessRateTrajectory([2.5, 2.8]).kind, 'consistent');
});

test('projectWithDecay lands below the flat projection and never reverses', () => {
  const flat = 300 + 2.8 * 15;                         // 342
  const decayed = projectWithDecay(300, 2.8, -0.3, 15); // rate eases toward 0
  assert.ok(decayed < flat, `decayed ${decayed} should be < flat ${flat}`);
  assert.ok(decayed > 300, 'a positive (if easing) rate still rises overall');
});

test('classifySeverity: noisy trajectory (allowRed=false) downgrades a would-be RED to YELLOW', () => {
  const base = { currentValue: 260, rate: 2.8, projected: 302, projectedExtended: 340 };
  assert.equal(classifySeverity({ ...base, allowRed: true }), 'red');
  assert.equal(classifySeverity({ ...base, allowRed: false }), 'yellow');
});

test('classifySeverity: a decayed redProjected under the red band yields YELLOW not RED', () => {
  // Flat 15-min projection would be red (255), but the decay-dampened one (240)
  // stays under redHigh -> only the yellow tier (off the flat projection) fires.
  const severity = classifySeverity({
    currentValue: 240, rate: 1.0, projected: 255, projectedExtended: 260, redProjected: 240,
  });
  assert.equal(severity, 'yellow');
});

test('buildNotificationMessage shows both projection windows', () => {
  const msg = buildNotificationMessage('red', 234, 2.8, 262, 295, 30);
  assert.match(msg, /262 in 15 min/);
  assert.match(msg, /295 in 30 min/);
});

// ---- integration: don't weaken a genuine climb, do suppress a noisy spike ----

function stubDeps() {
  return { deps: { sendPushNotification: async () => {}, callGeminiForAnalysis: async () => ({}) } };
}

test("real sustained climb (tonight's case) still fires RED", async () => {
  const { deps } = stubDeps();
  const now = Date.now();
  const readings = [180, 195, 210, 225, 240].map((sgv, i) => ({ sgv, date: now - (4 - i) * 5 * 60 * 1000 }));
  const result = await processNewReading(readings, deps);
  assert.equal(result.severity, 'red');
  assert.equal(result.rateTrajectory, 'consistent');
});

test('a noisy bouncing spike does not fire RED - waits as YELLOW', async () => {
  const { deps } = stubDeps();
  const now = Date.now();
  const readings = [230, 200, 235, 205, 255].map((sgv, i) => ({ sgv, date: now - (4 - i) * 5 * 60 * 1000 }));
  const result = await processNewReading(readings, deps);
  assert.equal(result.rateTrajectory, 'noisy');
  assert.equal(result.severity, 'yellow');
});

test('debug tuning overrides server defaults for one request without mutating defaults', () => {
  assert.equal(
    classifySeverity({ currentValue: 120, rate: 0.5, projected: 205, projectedExtended: 210 }),
    'yellow',
  );
  assert.equal(
    classifySeverity({
      currentValue: 120,
      rate: 0.5,
      projected: 205,
      projectedExtended: 210,
      tuning: { yellowProjectedHigh: 220, redProjectedHigh: 260 },
    }),
    'none',
  );
});

// ---- calculateRate: reacts to the latest movement, not a stale window ----

function readingsAt(sgvs, now = Date.now()) {
  return sgvs.map((sgv, i) => ({ sgv, date: now - (sgvs.length - 1 - i) * 5 * 60 * 1000 }));
}

test('rate reacts to a fresh drop after a rise (regression: reported +0.6 lag)', () => {
  // Rising, then the newest reading turns down. A windowed slope would still
  // read positive; the two-point-recent rate must go negative immediately.
  const rate = calculateRate(readingsAt([210, 215, 220, 227, 220]));
  assert.ok(rate < 0, `expected negative rate on reversal, got ${rate}`);
  assert.equal(rate, (220 - 227) / 5); // -1.4, the newest interval alone
});

test('steady decline: rate is the smoothed two-interval average', () => {
  // Same direction throughout -> light average of the last two intervals.
  const rate = calculateRate(readingsAt([105, 101, 97, 93, 89]));
  assert.equal(rate, -0.8);
});

test('single reading yields no rate', () => {
  assert.equal(calculateRate(readingsAt([120])), null);
});

test('reversal overrides smoothing within one cycle', () => {
  // Falling, then a sharp rise on the newest reading -> positive, not averaged.
  const rate = calculateRate(readingsAt([120, 116, 112, 108, 118]));
  assert.equal(rate, (118 - 108) / 5); // +2.0
});

// Helper: extended (30-min) projection from a current value + slope, matching
// projectGlucose(current, rate, 30). Keeps the unit-test inputs honest.
const ext = (current, rate) => Math.round(current + rate * 30);

// ---- classifySeverity: the reported false positives ----

test('198 falling -0.8 (projected 187) is none - was firing yellow on being >160', () => {
  const severity = classifySeverity({
    currentValue: 198, rate: -0.8, projected: 187, projectedExtended: ext(198, -0.8), // 174
  });
  assert.equal(severity, 'none');
});

test('163 falling -1.1 (projected 147) is none - was firing yellow on being >160', () => {
  const severity = classifySeverity({
    currentValue: 163, rate: -1.1, projected: 147, projectedExtended: ext(163, -1.1), // 130
  });
  assert.equal(severity, 'none');
});

// ---- classifySeverity: real danger still escalates ----

test('90 crashing -2/min (projected 60) is red', () => {
  const severity = classifySeverity({
    currentValue: 90, rate: -2, projected: 60, projectedExtended: ext(90, -2), // 30
  });
  assert.equal(severity, 'red');
});

test('210 falling -1 (projected 195) toward safe stays none - direction matters', () => {
  const severity = classifySeverity({
    currentValue: 210, rate: -1, projected: 195, projectedExtended: ext(210, -1), // 180
  });
  assert.equal(severity, 'none');
});

// ---- yellow via approaching a caution zone ----

test('projection drifting toward low caution zone (85) is yellow', () => {
  assert.equal(classifySeverity({ currentValue: 100, rate: -1, projected: 85, projectedExtended: 70 }), 'yellow');
});

test('projection drifting toward high caution zone (205) is yellow', () => {
  assert.equal(classifySeverity({ currentValue: 190, rate: 1, projected: 205, projectedExtended: 220 }), 'yellow');
});

// ---- yellow via the extended-horizon (fast move heading to red) nudge ----

test('fast rise: 15-min projection safe (195) but 30-min reaches red (270) is yellow', () => {
  assert.equal(classifySeverity({ currentValue: 120, rate: 5, projected: 195, projectedExtended: 270 }), 'yellow');
});

test('extended nudge does not fire when heading toward safe', () => {
  // Steeply falling from high: 30-min extrapolation lands mid-range, not red.
  assert.equal(classifySeverity({ currentValue: 210, rate: -1, projected: 195, projectedExtended: 180 }), 'none');
});

// ---- worsening-in-danger red (already past threshold, still going deeper) ----

test('already low (65) and still falling is red even if 15-min projection rounds safe', () => {
  assert.equal(classifySeverity({ currentValue: 65, rate: -0.5, projected: 75, projectedExtended: 60 }), 'red');
});

test('already high (255) and still rising is red even if 15-min projection dips under 250', () => {
  assert.equal(classifySeverity({ currentValue: 255, rate: 0.5, projected: 245, projectedExtended: 260 }), 'red');
});

test('already low (65) but recovering (rising) is not red - yellow from proximity only', () => {
  assert.equal(classifySeverity({ currentValue: 65, rate: 1, projected: 85, projectedExtended: 95 }), 'yellow');
});

// ---- boundaries ----

test('projected boundary: 90 is yellow, 91 is none', () => {
  const base = { currentValue: 110, rate: -1 };
  assert.equal(classifySeverity({ ...base, projected: 90, projectedExtended: 80 }), 'yellow');
  assert.equal(classifySeverity({ ...base, projected: 91, projectedExtended: 82 }), 'none');
});

test('projected boundary: 200 is yellow, 199 is none', () => {
  const base = { currentValue: 190, rate: 1 };
  assert.equal(classifySeverity({ ...base, projected: 200, projectedExtended: 210 }), 'yellow');
  assert.equal(classifySeverity({ ...base, projected: 199, projectedExtended: 208 }), 'none');
});

test('projected boundary: 70 is red, 71 is yellow', () => {
  const base = { currentValue: 100, rate: -2 };
  assert.equal(classifySeverity({ ...base, projected: 70, projectedExtended: 40 }), 'red');
  assert.equal(classifySeverity({ ...base, projected: 71, projectedExtended: 72 }), 'yellow');
});

test('projected boundary: 250 is red, 249 is yellow', () => {
  const base = { currentValue: 220, rate: 2 };
  assert.equal(classifySeverity({ ...base, projected: 250, projectedExtended: 280 }), 'red');
  assert.equal(classifySeverity({ ...base, projected: 249, projectedExtended: 248 }), 'yellow');
});

test('mid-range projection with no danger extrapolation is none', () => {
  assert.equal(classifySeverity({ currentValue: 120, rate: 0.2, projected: 123, projectedExtended: 126 }), 'none');
});

// ---- processNewReading integration (unchanged rate/projection math) ----

function readingsAtFiveMinSpacing(sgvs, now = Date.now()) {
  return sgvs.map((sgv, i) => ({
    sgv,
    date: now - (sgvs.length - 1 - i) * 5 * 60 * 1000,
  }));
}

function stubs() {
  const pushCalls = [];
  return {
    pushCalls,
    deps: {
      sendPushNotification: async (msg) => { pushCalls.push(msg); },
      callGeminiForAnalysis: async () => ({}),
    },
  };
}

test('decline to 89 (projected 77 <= 90) scores yellow', async () => {
  const { pushCalls, deps } = stubs();
  const result = await processNewReading(readingsAtFiveMinSpacing([105, 101, 97, 93, 89]), deps);

  assert.equal(result.severity, 'yellow');
  assert.equal(result.projected, 77);
  assert.equal(pushCalls.length, 1);
});

test('decline to 82 (projected 70) scores red with full-screen alert', async () => {
  const { deps } = stubs();
  const result = await processNewReading(readingsAtFiveMinSpacing([98, 94, 90, 86, 82]), deps);

  assert.equal(result.severity, 'red');
  assert.equal(result.projected, 70);
  assert.equal(result.fullScreenAlert, true);
});

test('mildly high but falling toward safe does not alert', async () => {
  // 198-ish plateau easing down: the exact class of false positive this fixes.
  const { pushCalls, deps } = stubs();
  const result = await processNewReading(readingsAtFiveMinSpacing([206, 204, 202, 200, 198]), deps);

  assert.equal(result.severity, 'none');
  assert.equal(pushCalls.length, 0);
});

test('reported bug: rose to 227 then dropped to 220 -> projection points DOWN, not up', async () => {
  // Before the rate fix this reported +0.6/min and projected a rise to ~229 off
  // a value that had just fallen. The projection must now reflect the drop.
  const { deps } = stubs();
  const result = await processNewReading(readingsAtFiveMinSpacing([210, 215, 220, 227, 220]), deps);

  assert.ok(result.rate < 0, `expected negative rate, got ${result.rate}`);
  assert.ok(result.projected < 220, `expected projection below current 220, got ${result.projected}`);
});
