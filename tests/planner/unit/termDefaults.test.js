import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TERM_SETTINGS,
  teachableMinutesPerDay,
  termWeeks,
  defaultDurationFor,
  workingDays,
} from '../../../services/planner/domain/termDefaults.js';

test('default settings match the contract', () => {
  assert.equal(DEFAULT_TERM_SETTINGS.day_start_min, 510);
  assert.equal(DEFAULT_TERM_SETTINGS.day_end_min, 1065);
  assert.equal(DEFAULT_TERM_SETTINGS.grid_minutes, 15);
  assert.equal(DEFAULT_TERM_SETTINGS.theory_minutes, 60);
  assert.equal(DEFAULT_TERM_SETTINGS.lab_minutes, 120);
  assert.deepEqual([...DEFAULT_TERM_SETTINGS.working_days], [0, 1, 2, 3, 4]);
  assert.equal(DEFAULT_TERM_SETTINGS.breaks.length, 3);
});

test('teachableMinutesPerDay: defaults give 480', () => {
  assert.equal(teachableMinutesPerDay({}), 480);
  assert.equal(teachableMinutesPerDay(null), 480);
});

test('teachableMinutesPerDay: custom day and breaks', () => {
  assert.equal(teachableMinutesPerDay({ day_start_min: 540, day_end_min: 1020, breaks: [] }), 480);
  assert.equal(
    teachableMinutesPerDay({ day_start_min: 540, day_end_min: 1020, breaks: [{ start_min: 720, end_min: 780 }] }),
    420,
  );
});

test('teachableMinutesPerDay: breaks outside the day are ignored, partial ones clipped, overlaps merged', () => {
  const term = {
    day_start_min: 600,
    day_end_min: 900,
    breaks: [
      { start_min: 500, end_min: 620 }, // 20 minutes inside
      { start_min: 1000, end_min: 1100 }, // outside
      { start_min: 700, end_min: 760 },
      { start_min: 740, end_min: 780 }, // overlaps the previous: merged 700-780 = 80
    ],
  };
  assert.equal(teachableMinutesPerDay(term), 300 - 20 - 80);
});

test('teachableMinutesPerDay: inverted day gives 0', () => {
  assert.equal(teachableMinutesPerDay({ day_start_min: 900, day_end_min: 600 }), 0);
});

test('termWeeks: ceil((end - start + 1) / 7)', () => {
  assert.equal(termWeeks({ start_date: '2026-07-27', end_date: '2026-08-02' }), 1); // 7 days
  assert.equal(termWeeks({ start_date: '2026-07-27', end_date: '2026-08-03' }), 2); // 8 days
  assert.equal(termWeeks({ start_date: '2026-07-27', end_date: '2026-11-08' }), 15);
  assert.equal(termWeeks({ start_date: '2026-07-27', end_date: '2026-07-27' }), 1);
});

test('termWeeks: null when dates missing or invalid', () => {
  assert.equal(termWeeks({}), null);
  assert.equal(termWeeks(null), null);
  assert.equal(termWeeks({ start_date: '2026-07-27' }), null);
  assert.equal(termWeeks({ start_date: 'nope', end_date: '2026-08-01' }), null);
  assert.equal(termWeeks({ start_date: '2026-08-10', end_date: '2026-08-01' }), null);
});

test('termWeeks accepts ISO timestamps and Date objects', () => {
  assert.equal(termWeeks({ start_date: '2026-07-27T00:00:00.000Z', end_date: '2026-08-02T00:00:00.000Z' }), 1);
  assert.equal(termWeeks({ start_date: new Date(2026, 6, 27), end_date: new Date(2026, 7, 3) }), 2);
});

test('defaultDurationFor', () => {
  assert.equal(defaultDurationFor('theory', {}), 60);
  assert.equal(defaultDurationFor('lab', {}), 120);
  assert.equal(defaultDurationFor('lab', { lab_minutes: 90, theory_minutes: 50 }), 90);
  assert.equal(defaultDurationFor('theory', { lab_minutes: 90, theory_minutes: 50 }), 50);
  assert.equal(defaultDurationFor('theory', null), 60);
});

test('workingDays falls back to Mon-Fri', () => {
  assert.deepEqual(workingDays({}), [0, 1, 2, 3, 4]);
  assert.deepEqual(workingDays({ working_days: [0, 1, 2, 3, 4, 5] }), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(workingDays({ working_days: [] }), [0, 1, 2, 3, 4]);
});
