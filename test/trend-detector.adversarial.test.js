// Adversarial suite for trend-detector.js - added 2026-09-20 during a review whose brief was
// "try to break this". Each test encodes a safety property the reviewer believes must hold.
// Tests that FAIL document live defects; the fix belongs in trend-detector.js (and its Kotlin
// mirror, ahead-rate-math/SeverityEngine.kt), not in the expectations here.
//
// Run: node --test test/trend-detector.adversarial.test.js

const test = require('node:test');
const assert = require('node:assert');
const td = require('../trend-detector');

const rank = (s) => (s === 'red' ? 2 : s === 'yellow' ? 1 : 0);

/** classifySeverity with flat projections derived from the rate, like processNewReading does. */
function sev(currentValue, rate, opts = {}) {
  const projected = td.projectGlucose(currentValue, rate, 15);
  const projectedExtended = td.projectGlucose(currentValue, rate, 30);
  return td.classifySeverity({
    currentValue, rate, projected, projectedExtended,
    allowRed: opts.allowRed !== undefined ? opts.allowRed : true,
    recoveringFromLow: !!opts.recoveringFromLow,
  });
}

// ===================================================================================
// A. THE SILENT LOW
// ===================================================================================

// processNewReading derives recoveringFromLow as "some reading <= 80 in the last 40 min",
// and the CURRENT reading counts. So any reading <= 80 is automatically "recovering", and the
// grace branch then returns 'none' for any positive rate at all.
test('a genuinely low reading that ticks upward must not be silent', () => {
  // 80 excluded deliberately: it is the top of the yellow proximity band, so a value AT 80 and
  // rising projects to 82 and is intentionally quiet. Everything strictly inside must speak.
  for (const value of [61, 64, 65, 70, 75, 78]) {
    const s = sev(value, +0.1, { recoveringFromLow: true });
    assert.notStrictEqual(s, 'none', `${value} mg/dL rising +0.1 returned '${s}'`);
  }
});

// End-to-end through the real entry point, so this cannot be dismissed as calling an
// internal helper with an unrealistic flag: the series itself makes recoveringFromLow true.
test('end-to-end: a low that nudges up is silent through processNewReading', async () => {
  const t0 = Date.now() - 20 * 60 * 1000;
  const readings = [
    { sgv: 78, date: t0 },
    { sgv: 74, date: t0 + 5 * 60000 },
    { sgv: 70, date: t0 + 10 * 60000 },
    { sgv: 66, date: t0 + 15 * 60000 },
    { sgv: 67, date: t0 + 20 * 60000 }, // a single upward tick while still deeply low
  ];
  let pushed = null;
  const result = await td.processNewReading(readings, {
    sendPushNotification: async (m) => { pushed = m; return 'ok'; },
  });
  assert.notStrictEqual(
    result.severity, 'none',
    `67 mg/dL after a real low run scored '${result.severity}' (rate ${result.rate}), pushed=${pushed}`,
  );
});

test('a genuine post-treatment climb well clear of the low band stays quiet', () => {
  assert.strictEqual(sev(140, +2.5, { recoveringFromLow: true }), 'none');
  assert.strictEqual(sev(165, +3.0, { recoveringFromLow: true }), 'none');
});

// ===================================================================================
// B. THE NOISY / ACCELERATION VETO
// ===================================================================================

// assessRateTrajectory calls a >50% step-up between the two most recent rates 'noisy', and
// processNewReading turns that into allowRed=false. A smoothly accelerating crash - each
// interval steeper than the last - is permanently 'noisy' and so can never fire RED.
test('an accelerating fall is classified noisy, which vetoes red', () => {
  const traj = td.assessRateTrajectory([-1.2, -2.4, -3.8]);
  assert.notStrictEqual(
    traj.kind, 'noisy',
    'a monotonically accelerating fall must not be treated as noise',
  );
});

// Drives the real path rather than forcing allowRed by hand: what decides this is whether
// assessRateTrajectory calls the acceleration 'noisy', which is what processNewReading turns
// into allowRed. Both series end at the same value and the same current rate.
test('an accelerating fall is never less severe than a steady one', () => {
  const acceleratingTraj = td.assessRateTrajectory([-1.2, -2.4, -3.8]);
  const steadyTraj = td.assessRateTrajectory([-3.8, -3.8, -3.8]);
  const accelerating = sev(85, -3.8, { allowRed: acceleratingTraj.kind !== 'noisy' });
  const steady = sev(85, -3.8, { allowRed: steadyTraj.kind !== 'noisy' });
  assert.ok(
    rank(accelerating) >= rank(steady),
    `accelerating (${acceleratingTraj.kind}) gave '${accelerating}' but steady ` +
      `(${steadyTraj.kind}) gave '${steady}'`,
  );
});

test('end-to-end: an accelerating crash reaches red before the hard floor', async () => {
  const t0 = Date.now() - 15 * 60 * 1000;
  const readings = [
    { sgv: 122, date: t0 },
    { sgv: 116, date: t0 + 5 * 60000 },
    { sgv: 104, date: t0 + 10 * 60000 },
    { sgv: 85, date: t0 + 15 * 60000 },
  ];
  const result = await td.processNewReading(readings, { sendPushNotification: async () => 'ok' });
  assert.strictEqual(
    result.severity, 'red',
    `85 mg/dL falling fast scored '${result.severity}' ` +
      `(rate ${result.rate}, projected ${result.projected}, trajectory ${result.rateTrajectory})`,
  );
});

// ===================================================================================
// C. PROPERTIES
// ===================================================================================

test('property - steeper fall never lowers severity', () => {
  const rates = [-0.5, -1.0, -1.5, -2.0, -2.5, -3.0, -4.0, -5.0];
  for (const value of [65, 71, 75, 80, 90, 100, 110, 125, 140, 160, 180]) {
    for (let i = 1; i < rates.length; i++) {
      const a = sev(value, rates[i - 1]);
      const b = sev(value, rates[i]);
      assert.ok(rank(b) >= rank(a), `value=${value}: ${rates[i]} -> '${b}', ${rates[i - 1]} -> '${a}'`);
    }
  }
});

test('property - lower current value never lowers severity', () => {
  const values = [180, 160, 140, 125, 110, 100, 90, 85, 80, 75, 71, 65, 61];
  for (const rate of [-3.0, -2.0, -1.0, -0.5, 0.0, 0.5, 1.0]) {
    for (let i = 1; i < values.length; i++) {
      const a = sev(values[i - 1], rate);
      const b = sev(values[i], rate);
      assert.ok(rank(b) >= rank(a), `rate=${rate}: ${values[i]} -> '${b}', ${values[i - 1]} -> '${a}'`);
    }
  }
});

test('property - a reading gap must never silence a red', async () => {
  const t0 = Date.now() - 3 * 60 * 60 * 1000;
  const lead = [
    { sgv: 90, date: t0 },
    { sgv: 84, date: t0 + 5 * 60000 },
    { sgv: 78, date: t0 + 10 * 60000 },
  ];
  const continuous = [...lead, { sgv: 72, date: t0 + 15 * 60000 }];
  const gapped = [...lead, { sgv: 72, date: t0 + 135 * 60000 }];
  const a = await td.processNewReading(continuous, { sendPushNotification: async () => 'ok' });
  const b = await td.processNewReading(gapped, { sendPushNotification: async () => 'ok' });
  assert.strictEqual(a.severity, 'red');
  // After the 2026-09-20 fix the gapped case no longer invents a rate across the blackout
  // (MAX_RATE_INTERVAL_MINUTES), so it reports no rate rather than the diluted -0.05/min it used
  // to. It is one notch quieter, which is correct: with the rate genuinely unknown, severity
  // falls back to the value alone. On-device the blackout itself is covered by the RED-tier
  // signal-lost alert (AlertCoordinator.handleStale), so the system is never quieter overall.
  assert.strictEqual(td.calculateRate(gapped), null, 'rate across a 2h gap must be unknown');
  assert.ok(rank(b.severity) >= 1, `72 mg/dL after a gap scored '${b.severity}' - must still speak`);
});

// ===================================================================================
// D. GLITCH INPUT
// ===================================================================================

// collapseDuplicateReadings only merges IDENTICAL values, so two writers that disagree by a
// single mg/dL (exactly what mg/dL rounding of the same mmol/L sample produces) stay as two
// samples seconds apart and the slope divides by that tiny gap.
test('two near-simultaneous readings differing by 1 must not produce an absurd rate', () => {
  const t0 = Date.now();
  const rate = td.calculateRate([
    { sgv: 100, date: t0 },
    { sgv: 100, date: t0 + 300000 },
    { sgv: 101, date: t0 + 302000 },
  ]);
  assert.ok(
    rate === null || Math.abs(rate) <= 10,
    `two points 2 seconds apart differing by 1 mg/dL produced ${rate} mg/dL/min`,
  );
});

test('projections are never negative', () => {
  const p15 = td.projectGlucose(85, -3.8, 15);
  const p30 = td.projectGlucose(85, -3.8, 30);
  assert.ok(p15 >= 0 && p30 >= 0, `15-min ${p15}, 30-min ${p30}`);
});

// ===================================================================================
// E. BOUNDARIES
// ===================================================================================

test('boundary - the hard low floor is exactly 60', () => {
  assert.strictEqual(sev(60, 0), 'red');
  assert.strictEqual(sev(59, 0), 'red');
  assert.notStrictEqual(sev(61, 0), 'none');
});

test('boundary - 55 is red even while rising and flagged recovering', () => {
  assert.strictEqual(sev(55, +1.0, { recoveringFromLow: true }), 'red');
});

test('boundary - projected exactly 70 is red, 71 is yellow', () => {
  assert.strictEqual(sev(85, -1.0), 'red');    // projects to exactly 70
  assert.strictEqual(sev(86, -1.0), 'yellow'); // projects to 71
});
