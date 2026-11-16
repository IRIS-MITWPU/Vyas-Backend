/**
 * Small hand-built planner states for unit tests. `baseState()` is a minimal state that is fully ready
 * (no errors, warnings or info). Tests clone it and perturb one thing.
 */

export function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

export function makeBatches(divisionId, names, size, wholeSize) {
  return [
    { id: `${divisionId}-ALL`, name: 'ALL', student_count: wholeSize, is_whole: true },
    ...names.map((n) => ({ id: `${divisionId}-${n}`, name: n, student_count: size, is_whole: false })),
  ];
}

/**
 * Term of 15 weeks (2026-07-27 .. 2026-11-08), Mon-Fri, 08:30-17:45 with the default breaks
 * => 480 teachable minutes/day => 40 teachable hours/week.
 */
export function baseTerm() {
  return {
    id: 'term-1',
    start_date: '2026-07-27',
    end_date: '2026-11-08',
    working_days: [0, 1, 2, 3, 4],
    day_start_min: 510,
    day_end_min: 1065,
    grid_minutes: 15,
    theory_minutes: 60,
    lab_minutes: 120,
    breaks: [
      { start_min: 630, end_min: 645, label: 'Short break 1' },
      { start_min: 765, end_min: 810, label: 'Lunch' },
      { start_min: 930, end_min: 945, label: 'Short break 2' },
    ],
  };
}

export function baseState() {
  return {
    term: baseTerm(),
    rooms: [
      { id: 'tr-1', room_id: 'room-1', is_lab: false, name: 'C101', building_name: 'Main', capacity: 70 },
      { id: 'tr-2', room_id: 'room-2', is_lab: true, name: 'Lab 1', building_name: 'Main', capacity: 30 },
      { id: 'tr-3', room_id: 'room-3', is_lab: true, name: 'Lab 2', building_name: 'Main', capacity: 30 },
      { id: 'tr-4', room_id: 'room-4', is_lab: true, name: 'Lab 3', building_name: 'Main', capacity: 30 },
    ],
    faculty: [
      { id: 'f1', short_code: 'Sharma', full_name: 'Sharma', profile_id: 'p1', max_per_day: 4, max_per_week: 16 },
      { id: 'f2', short_code: 'Patil', full_name: 'Patil', profile_id: 'p2', max_per_day: 4, max_per_week: 16 },
    ],
    subjects: [
      { id: 's-ds', code: 'DS', name: 'Data Structures', kind: 'theory', duration_min: 60, weekly_count: 4, semester_total: 60 },
      { id: 's-dsl', code: 'DS Lab', name: 'DS Lab', kind: 'lab', duration_min: 120, weekly_count: 1, semester_total: 15 },
    ],
    divisions: [
      {
        id: 'd1',
        semester: 3,
        name: 'CSE-A',
        student_count: 60,
        home_room_id: 'room-1',
        batches: makeBatches('d1', ['A1', 'A2', 'A3'], 20, 60),
      },
    ],
    offerings: [
      { id: 'o-ds', division_id: 'd1', subject_id: 's-ds', weekly_count: null, per_batch: false, faculty: [{ batch_id: null, faculty_id: 'f1', role: 'lead' }] },
      { id: 'o-dsl', division_id: 'd1', subject_id: 's-dsl', weekly_count: null, per_batch: true, faculty: [{ batch_id: null, faculty_id: 'f2', role: 'lead' }] },
    ],
  };
}
