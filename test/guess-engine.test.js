// Run with: npm test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateGuesses } = require('../guess-engine.js');

const now = Date.now();
const at = (mins) => now - mins * 60 * 1000;
const readings = (sgvs) => sgvs.map((sgv, i) => ({ sgv, date: at((sgvs.length - 1 - i) * 5) }));

const ctx = (over) => ({
  currentValue: 200, rate: 0, severity: 'yellow',
  readings: readings([200, 200]), timeOfDayHour: 14, minutesSinceLastBolus: null, ...over,
});

test('non-event returns no guesses', () => {
  const g = generateGuesses(ctx({ severity: 'none', currentValue: 100, readings: readings([100, 100]) }));
  assert.deepEqual(g, []);
});

test('fast-rising high suggests an uncovered meal (high confidence)', () => {
  const g = generateGuesses(ctx({ currentValue: 240, rate: 2.5, readings: readings([210, 240]) }));
  const meal = g.find(x => x.label === 'High-carb meal not yet covered?');
  assert.ok(meal, 'meal guess present');
  assert.equal(meal.confidence, 'high');
});

test('early-morning rise suggests dawn phenomenon', () => {
  const g = generateGuesses(ctx({ currentValue: 190, rate: 1.2, timeOfDayHour: 6, readings: readings([175, 190]) }));
  assert.ok(g.some(x => x.label === 'Dawn phenomenon?'));
});

test('dropping low suggests exercise', () => {
  const g = generateGuesses(ctx({ currentValue: 68, rate: -1.5, severity: 'red', readings: readings([90, 68]) }));
  assert.ok(g.some(x => x.label === 'Recent exercise pulling you down?'));
});

test('bolus-dependent guesses are DISABLED (commented out) until logging exists', () => {
  // A stubborn high with no recent bolus would trigger "missed bolus?" once the
  // bolus block is enabled - it must NOT appear while that block is commented.
  const g = generateGuesses(ctx({ currentValue: 260, rate: 0.1, minutesSinceLastBolus: null, readings: readings([258, 260]) }));
  assert.ok(!g.some(x => /bolus/i.test(x.label)), 'no bolus guesses while disabled');
});

test('every guess is phrased as a question', () => {
  const g = generateGuesses(ctx({ currentValue: 250, rate: 2.0, readings: readings([220, 250]) }));
  assert.ok(g.length > 0);
  assert.ok(g.every(x => x.label.trim().endsWith('?')), 'all guesses are questions');
});

test('returns at most 4 guesses, highest confidence first', () => {
  const g = generateGuesses(ctx({ currentValue: 300, rate: 2.5, timeOfDayHour: 6, readings: readings([65, 300]) }));
  assert.ok(g.length <= 4);
  for (let i = 1; i < g.length; i++) {
    const rank = { high: 3, medium: 2, low: 1 };
    assert.ok(rank[g[i - 1].confidence] >= rank[g[i].confidence], 'sorted by confidence');
  }
});

test('eventful with no matching rule falls back to no-clear-pattern', () => {
  // Out-of-range (sustained) but no directional rule matches.
  const g = generateGuesses(ctx({ currentValue: 170, rate: 0, severity: 'none', readings: readings([170, 170]) }));
  assert.deepEqual(g, [{ label: 'No clear pattern - worth a manual check?', confidence: 'low' }]);
});
