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
} = require('../trend-detector.js');

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
