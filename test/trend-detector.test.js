// Run with: npm test  (node --test test/)
// Zero-dependency tests via node:test - guards the severity tiering, in
// particular the projected-value yellow band that keeps a slow decline from
// jumping none -> red with no warning tier in between.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifySeverity,
  processNewReading,
} = require('../trend-detector.js');

// ---- classifySeverity units ----

test('slow decline projecting into warning band is yellow (regression: was none)', () => {
  // The reported bug: 89 mg/dL at -0.8/min, projected 77. Yellow rate needs
  // <= -1.5 and the critical projected band needs <= 70, so before the
  // projected-warning band this scored 'none' and the first alert the user
  // ever saw was red.
  const severity = classifySeverity({
    recentRate: -0.8,
    trendPhase: 'steady',
    projected: 77,
    consecutiveOutOfRange: 0,
  });
  assert.equal(severity, 'yellow');
});

test('projection at the critical low boundary is still red', () => {
  const severity = classifySeverity({
    recentRate: -0.8,
    trendPhase: 'steady',
    projected: 70,
    consecutiveOutOfRange: 0,
  });
  assert.equal(severity, 'red');
});

test('red-rate decline that is decelerating downgrades to yellow', () => {
  const severity = classifySeverity({
    recentRate: -2.6,
    trendPhase: 'decelerating',
    projected: 72,
    consecutiveOutOfRange: 0,
  });
  assert.equal(severity, 'yellow');
});

test('benign steady reading is none', () => {
  const severity = classifySeverity({
    recentRate: 0.2,
    trendPhase: 'steady',
    projected: 100,
    consecutiveOutOfRange: 0,
  });
  assert.equal(severity, 'none');
});

test('slow rise projecting above the warning band is yellow', () => {
  const severity = classifySeverity({
    recentRate: 1.0,
    trendPhase: 'steady',
    projected: 205,
    consecutiveOutOfRange: 0,
  });
  assert.equal(severity, 'yellow');
});

test('warning band boundary: projected 80 is yellow, 81 is none', () => {
  const base = { recentRate: -0.2, trendPhase: 'steady', consecutiveOutOfRange: 0 };
  assert.equal(classifySeverity({ ...base, projected: 80 }), 'yellow');
  assert.equal(classifySeverity({ ...base, projected: 81 }), 'none');
});

test('yellow rate threshold alone still fires yellow', () => {
  const severity = classifySeverity({
    recentRate: -1.5,
    trendPhase: 'steady',
    projected: 100,
    consecutiveOutOfRange: 0,
  });
  assert.equal(severity, 'yellow');
});

test('red rate threshold alone still fires red', () => {
  const severity = classifySeverity({
    recentRate: -2.5,
    trendPhase: 'steady',
    projected: 100,
    consecutiveOutOfRange: 0,
  });
  assert.equal(severity, 'red');
});

// ---- processNewReading integration ----

function readingsAtFiveMinSpacing(sgvs, now = Date.now()) {
  // Oldest -> newest, 5 minutes apart, ending at `now`.
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

test('steady -0.8/min decline from 105 to 89 scores yellow with projected 77', async () => {
  const { pushCalls, deps } = stubs();
  const result = await processNewReading(readingsAtFiveMinSpacing([105, 101, 97, 93, 89]), deps);

  assert.equal(result.severity, 'yellow');
  assert.equal(result.projected, 77);
  assert.equal(pushCalls.length, 1);
});

test('same decline reaching 82 scores red with full-screen alert', async () => {
  const { deps } = stubs();
  const result = await processNewReading(readingsAtFiveMinSpacing([98, 94, 90, 86, 82]), deps);

  assert.equal(result.severity, 'red');
  assert.equal(result.projected, 70);
  assert.equal(result.fullScreenAlert, true);
});
