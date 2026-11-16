/**
 * Single source of truth for planner field limits. Used by the API zod schemas (services/planner/*.js)
 * AND by the import validator (importSpec.js), so a value that the API rejects can never be imported.
 * Pure constants, no I/O. Numeric ranges are inclusive.
 */

/** Hard ceiling for any integer column (Postgres int4 is 2147483647). */
export const INT4_MAX = 2_000_000_000;

const range = (min, max) => Object.freeze({ min, max });

export const LIMITS = Object.freeze({
  // faculty
  short_code: 40,
  full_name: 120,
  email: 254,
  department: 120,
  max_per_day: range(1, 100),
  max_per_week: range(1, 1000),
  // subjects
  subject_code: 40,
  subject_name: 200,
  duration_min: range(1, 1440),
  weekly_count: range(0, 100),
  semester_total: range(0, 10000),
  // divisions and batches
  semester: range(1, 12),
  division_name: 60,
  student_count: range(0, 100000),
  batch_name: 40,
  batch_size: range(0, 100000),
  home_room: 300, // "<building> / <room>" in the import sheet
  // offerings
  faculty_per_offering: 200, // max entries in faculty_codes (same cap as the API's faculty list)
});
