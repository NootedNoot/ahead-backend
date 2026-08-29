// Run with: npm test  (node --test)
//
// Runs golden-vectors/severity-thresholds.json (in ahead-rate-math, a
// sibling repo) against THIS file's own severity threshold constants - the
// Kotlin module (ahead-rate-math's SeverityEngine, used live by
// ahead-android's real alert pipeline) runs the exact same file against its
// own constants. Exists because SeverityEngine.kt's DEFAULT_RED_HIGH
// silently drifted to 260 (should have been 250) while sitting uncommitted,
// found 2026-08-28 during a fragmentation audit - a real gap in high-side
// red-alert coverage, not just style debt, and nothing caught it
// automatically before this test existed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  YELLOW_PROJECTED_LOW,
  YELLOW_PROJECTED_HIGH,
  RED_PROJECTED_LOW,
  RED_PROJECTED_HIGH,
  SEVERE_LOW_RED_FLOOR,
  YELLOW_RATE_FALLING,
  YELLOW_RATE_RISING,
  VULNERABLE_DROP_CEILING_MGDL,
  VULNERABLE_RISE_FLOOR_MGDL,
  RECOVERY_REBOUND_CEILING_MGDL,
  POST_HYPO_RECOVERY_GRACE_WINDOW_MS,
} = require('../trend-detector.js');

const VECTORS_PATH = path.join(__dirname, '..', '..', 'ahead-rate-math', 'golden-vectors', 'severity-thresholds.json');

function loadVectors() {
  if (!fs.existsSync(VECTORS_PATH)) {
    throw new Error(`golden vectors not found at ${VECTORS_PATH} - expects ahead-rate-math as a sibling repo`);
  }
  return JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8'));
}

test('severity thresholds match the shared golden values', () => {
  const { thresholds } = loadVectors();
  assert.equal(YELLOW_PROJECTED_LOW, thresholds.yellowProjectedLow);
  assert.equal(YELLOW_PROJECTED_HIGH, thresholds.yellowProjectedHigh);
  assert.equal(RED_PROJECTED_LOW, thresholds.redProjectedLow);
  assert.equal(RED_PROJECTED_HIGH, thresholds.redProjectedHigh);
  assert.equal(SEVERE_LOW_RED_FLOOR, thresholds.severeLowRedFloor);
  assert.equal(YELLOW_RATE_FALLING, thresholds.yellowRateFalling);
  assert.equal(YELLOW_RATE_RISING, thresholds.yellowRateRising);
  assert.equal(VULNERABLE_DROP_CEILING_MGDL, thresholds.vulnerableDropCeilingMgdl);
  assert.equal(VULNERABLE_RISE_FLOOR_MGDL, thresholds.vulnerableRiseFloorMgdl);
  assert.equal(RECOVERY_REBOUND_CEILING_MGDL, thresholds.recoveryReboundCeilingMgdl);
  assert.equal(POST_HYPO_RECOVERY_GRACE_WINDOW_MS, thresholds.postHypoRecoveryGraceWindowMinutes * 60_000);
});
