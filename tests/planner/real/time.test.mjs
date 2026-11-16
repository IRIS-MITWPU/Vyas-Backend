import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPlacement } from '../../../services/planner/domain/placement.js';
import { fmt, parseHHMM, termShape, validPlacement, standardStarts, allStarts, segments, runContinues, dayStats, hash01, breakMinutesBetween, idleBetween } from './lib/time.mjs';
import { DEFAULT_TERM } from './lib/world.mjs';

const shape = termShape(DEFAULT_TERM);

test('time: fmt / parseHHMM', () => {
  assert.equal(fmt(510), '08:30');
  assert.equal(fmt(1065), '17:45');
  assert.equal(parseHHMM('10:45'), 645);
});

test('time: segments and standard starts come from the term breaks', () => {
  assert.deepEqual(segments(shape), [{ start: 510, end: 630 }, { start: 645, end: 765 }, { start: 810, end: 930 }, { start: 945, end: 1065 }]);
  assert.deepEqual(standardStarts(shape, 60).map(fmt), ['08:30', '09:30', '10:45', '11:45', '13:30', '14:30', '15:45', '16:45']);
  assert.deepEqual(standardStarts(shape, 120).map(fmt), ['08:30', '10:45', '13:30', '15:45']);
});

test('time: a different term changes the candidates (nothing is hard-coded)', () => {
  const t = termShape({ ...DEFAULT_TERM, day_start_min: 540, day_end_min: 900, breaks: [{ start_min: 720, end_min: 780, label: 'Lunch' }], working_days: [0, 1, 2] });
  assert.deepEqual(t.days, [0, 1, 2]);
  assert.deepEqual(standardStarts(t, 60).map(fmt), ['09:00', '10:00', '11:00', '13:00', '14:00']);
  assert.deepEqual(standardStarts(t, 120).map(fmt), ['09:00', '10:00', '13:00']);
});

test('time: allStarts never overlaps a break, stays on the grid and inside the day', () => {
  for (const term of [DEFAULT_TERM, { ...DEFAULT_TERM, grid_minutes: 30 }]) {
    const sh = termShape(term);
    for (const dur of [60, 120]) {
      const starts = allStarts(sh, dur);
      assert.ok(starts.length > 0);
      for (const s of starts) {
        assert.equal(s % 15, 0);
        assert.equal((s - sh.dayStart) % sh.grid, 0);
        assert.ok(s >= sh.dayStart && s + dur <= sh.dayEnd);
        for (const b of sh.breaks) assert.ok(!(s < b.end && s + dur > b.start), `${fmt(s)} overlaps a break`);
      }
    }
  }
  assert.ok(!allStarts(shape, 60).includes(585)); // 09:45-10:45 overlaps the 10:30 break
  assert.ok(allStarts(shape, 60).includes(645));
});

test('time: validPlacement agrees with the domain checkPlacement for every day / start / duration', () => {
  for (const term of [DEFAULT_TERM, { ...DEFAULT_TERM, grid_minutes: 30, working_days: [0, 2, 4] }]) {
    const sh = termShape(term);
    for (const duration of [60, 120]) {
      for (let day = 0; day < 7; day++) {
        for (let start = 0; start <= 1440; start += 15) {
          const mine = validPlacement(sh, duration, day, start);
          const dom = checkPlacement({ term, subject: { duration_min: duration }, weekday: day, start_min: start });
          assert.equal(mine.ok, dom.ok, `day ${day} start ${start} dur ${duration}`);
          if (!dom.ok) assert.equal(mine.reason, dom.reason, `reason day ${day} start ${start} dur ${duration}`);
          else assert.equal(mine.end, dom.end_min);
        }
      }
    }
  }
});

test('time: break arithmetic and run continuation', () => {
  assert.equal(breakMinutesBetween(shape, 600, 700), 15);
  assert.equal(idleBetween(shape, 630, 645), 0);
  assert.equal(idleBetween(shape, 765, 810), 0);
  assert.equal(idleBetween(shape, 705, 810), 60);
  assert.equal(runContinues(shape, 630, 645), true); // only the short break
  assert.equal(runContinues(shape, 765, 810), false); // lunch ends a run
  assert.equal(runContinues(shape, 720, 780), false); // free time in between
});

test('time: dayStats (hours, longest run, idle gaps)', () => {
  const run = dayStats(shape, [{ start: 510, end: 570 }, { start: 570, end: 630 }, { start: 645, end: 705 }]);
  assert.equal(run.hours, 3);
  assert.equal(run.maxRun, 3);
  assert.equal(run.idle, 0);
  const gap = dayStats(shape, [{ start: 510, end: 570 }, { start: 705, end: 765 }, { start: 810, end: 870 }]);
  assert.equal(gap.gaps, 1);
  assert.equal(gap.idle, 135 - 15); // free time 09:30-11:45 minus the 15 min break; lunch is not idle
  assert.equal(gap.maxRun, 1);
  assert.deepEqual(dayStats(shape, []), { hours: 0, maxRun: 0, idle: 0, gaps: 0, first: null, last: null });
});

test('time: hash01 is deterministic and in [0, 1)', () => {
  assert.equal(hash01('seed|x'), hash01('seed|x'));
  assert.notEqual(hash01('seed|x'), hash01('seed|y'));
  for (const k of ['a', 'b', 'c', '1|2|3']) assert.ok(hash01(k) >= 0 && hash01(k) < 1);
});
