// Run with: npm test  (node --test)
//
// Runs golden-vectors/rate-math-vectors.json (in ahead-rate-math, a sibling
// repo - see the workspace CLAUDE.md and ahead-rate-math/CLAUDE.md) against
// THIS file's dedup/trajectory/decay functions. The Kotlin module
// (ahead-rate-math, shared by ahead-android and ahead-lite-android) runs the
// exact same file against its own implementation. A case added on one side
// without the corresponding fix landing on the other fails a test here
// instead of surfacing as a field bug - see task #33's audit.
//
// Deliberately does NOT test `ratePerMinuteCases` against calculateRate as
// if the two were the same algorithm - they aren't (see trend-detector.js's
// calculateRate doc: 2-interval smoothing with a same-cycle reversal
// override, by design). It happens to be SAFE to do so here only because
// every case in ratePerMinuteCases (and the deduped remainder of
// dedupCases' rate case) has 2 or fewer real points, where calculateRate's
// smoothing branch can't engage anyway and it degrades to a plain
// pointToPointRate - the same thing ratePerMinute computes. If a case with
// 3+ points is ever added to that section, it needs its own reasoning, not
// a blind assertion.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  calculateRate,
  collapseDuplicateReadings,
  assessRateTrajectory,
  projectWithDecay,
} = require('../trend-detector.js');

const VECTORS_PATH = path.join(__dirname, '..', '..', 'ahead-rate-math', 'golden-vectors', 'rate-math-vectors.json');

function loadVectors() {
  if (!fs.existsSync(VECTORS_PATH)) {
    throw new Error(`golden vectors not found at ${VECTORS_PATH} - expects ahead-rate-math as a sibling repo`);
  }
  return JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8'));
}

// The Kotlin side's RatePoint is {epochMillis, sgv}; this file's readings
// are {date, sgv} - same shape, different field name for the timestamp.
const asReading = (point) => ({ sgv: point.sgv, date: point.epochMillis });

const vectors = loadVectors();

test('golden dedup cases', () => {
  for (const testCase of vectors.dedupCases) {
    const readings = testCase.points.map(asReading);

    if (testCase.expected) {
      const expected = testCase.expected.map(asReading);
      assert.deepEqual(collapseDuplicateReadings(readings), expected, `dedup case '${testCase.label}'`);
    }
    if (testCase.expectedRatePerMinute !== undefined) {
      const rate = calculateRate(readings);
      assert.ok(rate !== null, `rate-after-dedup case '${testCase.label}' should not be null`);
      assert.ok(
        Math.abs(rate - testCase.expectedRatePerMinute) < 0.0001,
        `rate-after-dedup case '${testCase.label}': expected ${testCase.expectedRatePerMinute}, got ${rate}`,
      );
    }
  }
});

test('golden rate-per-minute cases (2-point scenarios only - see file header)', () => {
  for (const testCase of vectors.ratePerMinuteCases) {
    const readings = testCase.points.map(asReading);
    const rate = calculateRate(readings);

    if (testCase.expectedRatePerMinute === null) {
      assert.equal(rate, null, `rate-per-minute case '${testCase.label}'`);
    } else {
      assert.ok(rate !== null, `rate-per-minute case '${testCase.label}' should not be null`);
      assert.ok(
        Math.abs(rate - testCase.expectedRatePerMinute) < 0.0001,
        `rate-per-minute case '${testCase.label}': expected ${testCase.expectedRatePerMinute}, got ${rate}`,
      );
    }
  }
});

test('golden trajectory cases', () => {
  for (const testCase of vectors.trajectoryCases) {
    const trajectory = assessRateTrajectory(testCase.rates);
    // Case-insensitive: this file's kind is a lowercase string literal
    // ('consistent'), the Kotlin side's is an uppercase enum constant
    // (CONSISTENT) - both are each language's own idiomatic casing for the
    // same classification, not a real difference to assert on.
    assert.equal(
      trajectory.kind.toUpperCase(),
      testCase.expectedKind.toUpperCase(),
      `trajectory kind for '${testCase.label}'`,
    );
    assert.ok(
      Math.abs(trajectory.avgDeltaPerStep - testCase.expectedAvgDeltaPerStep) < 0.0001,
      `trajectory avgDeltaPerStep for '${testCase.label}': expected ${testCase.expectedAvgDeltaPerStep}, got ${trajectory.avgDeltaPerStep}`,
    );
  }
});

test('golden projectWithDecay cases', () => {
  for (const testCase of vectors.projectWithDecayCases) {
    // projectWithDecay here returns just the final rounded value, not a
    // per-step list (see trend-detector.js) - the Kotlin side returns the
    // full step list, so compare against the LAST expected point's value.
    const result = projectWithDecay(
      testCase.currentValue,
      testCase.currentRate,
      testCase.avgDeltaPerStep,
      testCase.minutes,
      testCase.stepMinutes,
    );
    const lastExpected = testCase.expectedPoints[testCase.expectedPoints.length - 1];
    assert.equal(result, lastExpected.value, `projectWithDecay case '${testCase.label}'`);
  }
});
