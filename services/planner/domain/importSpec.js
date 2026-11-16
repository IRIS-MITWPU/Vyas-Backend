/**
 * CSV / XLSX import spec: templates, per-entity normalisation and validation. Pure, total
 * (never throws on garbage input), no I/O.
 *
 * validateImportRows(entity, rows, ctx) -> [{ row, status, errors, warnings, key, normalized }]
 *   row        1-based position in `rows`
 *   status     'create' | 'update' | 'error'
 *   errors     [{field, message}]; warnings the same shape
 *   key        natural key string (lowercased); '' when it cannot be built
 *   normalized null for error rows, otherwise the cleaned values (see each entity below)
 * Completely empty rows (every value blank) are skipped: they get no result entry.
 *
 * `ctx` (plain JSON, every part optional; keys are matched lowercased + trimmed). Each collection may be
 * an object map `{key: value}`, a Map, an array of key strings, or a Set. A value may be a string id, or
 * an object with an `id` (used to fill the `*_id` fields of `normalized`).
 *   {
 *     term:      { theory_minutes, lab_minutes, grid_minutes, ... },   // for duration defaults
 *     faculty:   { 'sharma': {id}, ... }                    // by lowercased short_code
 *     subjects:  { 'ds': {id, kind:'theory'|'lab'}, ... }   // by lowercased code
 *     divisions: { '3|cse-a': {id, batches?: ['A1','A2']}, ... }   // by "semester|name" lowercased;
 *                                                                  // `batches` (names) enables batch validation
 *     rooms:     { 'main building / 101': {id}, ... }       // by "building / name" lowercased; a value that is an
 *                                                           // array with >1 entry or {ambiguous:true} = ambiguous
 *     offerings: { '3|cse-a|ds': {id}, ... }                // by "semester|division|subject_code" lowercased
 *   }
 *
 * normalized shapes
 *   faculty   { short_code, full_name, email|null, department|null, max_per_day|null, max_per_week|null }
 *   subjects  { code, name, kind, weekly_count, semester_total|null, allow_second_lab, duration_min }
 *             A blank duration_min / allow_second_lab means "keep the stored value" on an UPDATE (normalized
 *             value null) and "term default for the kind" / false on a CREATE.
 *   divisions { semester, name, student_count, home_room|null, home_room_id|null,
 *               batch: {name, student_count|null}|null }     -- one per row; see groupImportRows
 *             A blank batch_size on an existing batch means "keep the stored size" (student_count null);
 *             on a new batch it warns and the batch is created with 0.
 * Every number and string is checked against the same limits as the API (see limits.js).
 *   offerings { semester, division, subject_code, subject_id|null, division_id|null, weekly_count|null,
 *               batch: string|null,
 *               faculty: [{short_code, faculty_id|null, role:'lead'|'assist'}] }   -- one per row; see groupImportRows
 */

import { defaultDurationFor } from './termDefaults.js';
import { LIMITS, INT4_MAX } from './limits.js';

export const IMPORT_ENTITIES = Object.freeze(['faculty', 'subjects', 'divisions', 'offerings']);

// ---------------------------------------------------------------- templates

const col = (key, label, required, description, example) => ({ key, label, required, description, example });

export const IMPORT_TEMPLATES = {
  faculty: {
    columns: [
      col('short_code', 'Short code', true, 'Unique short code used in the offerings sheet (case-insensitive). Cannot contain | , ; or :', 'Sharma'),
      col('full_name', 'Full name', true, 'Full name of the faculty member', 'Anil Sharma'),
      col('email', 'Email', false, 'Used to link the faculty member to their Vyas login', 'anil.sharma@mitwpu.edu.in'),
      col('department', 'Department', false, 'Department name', 'Computer Science'),
      col('max_per_day', 'Max sessions per day', false, 'Whole number, at least 1', '4'),
      col('max_per_week', 'Max sessions per week', false, 'Whole number, at least 1', '16'),
    ],
    sample_rows: [
      { short_code: 'Sharma', full_name: 'Anil Sharma', email: 'anil.sharma@mitwpu.edu.in', department: 'Computer Science', max_per_day: 4, max_per_week: 16 },
      { short_code: 'Patil', full_name: 'Sunita Patil', email: 'sunita.patil@mitwpu.edu.in', department: 'Computer Science', max_per_day: 4, max_per_week: 16 },
      { short_code: 'Kulkarni', full_name: 'Rahul Kulkarni', email: 'rahul.kulkarni@mitwpu.edu.in', department: 'Computer Science', max_per_day: 4, max_per_week: 16 },
    ],
  },
  subjects: {
    columns: [
      col('code', 'Subject code', true, 'Unique subject code within the term', 'DS'),
      col('name', 'Subject name', true, 'Full subject name', 'Data Structures'),
      col('kind', 'Kind', true, 'theory or lab', 'theory'),
      col('weekly_count', 'Sessions per week', true, 'Whole number, 0 or more (per batch for labs)', '4'),
      col('semester_total', 'Semester total', false, 'Total sessions over the semester; checked against weekly count x term weeks', '60'),
      col('allow_second_lab', 'Allow second lab', false, 'yes/no/true/false/1/0: allow two lab sessions in one week', 'no'),
      col('duration_min', 'Duration (minutes)', false, 'Blank = the term default for the kind (theory/lab)', '60'),
    ],
    sample_rows: [
      { code: 'DS', name: 'Data Structures', kind: 'theory', weekly_count: 4, semester_total: 60, allow_second_lab: 'no', duration_min: 60 },
      { code: 'OS', name: 'Operating Systems', kind: 'theory', weekly_count: 3, semester_total: 45, allow_second_lab: 'no', duration_min: 60 },
      { code: 'Maths', name: 'Engineering Mathematics', kind: 'theory', weekly_count: 4, semester_total: 60, allow_second_lab: 'no', duration_min: 60 },
      { code: 'CN', name: 'Computer Networks', kind: 'theory', weekly_count: 3, semester_total: 45, allow_second_lab: 'no', duration_min: 60 },
      { code: 'DS Lab', name: 'Data Structures Lab', kind: 'lab', weekly_count: 1, semester_total: 15, allow_second_lab: 'no', duration_min: 120 },
    ],
  },
  divisions: {
    columns: [
      col('semester', 'Semester', true, 'Number from 1 to 12', '3'),
      col('division', 'Division', true, 'Division name', 'CSE-A'),
      col('student_count', 'Student count', true, 'Students in the whole division', '60'),
      col('home_room', 'Home room', false, 'Format: "<building name> / <room name>"', 'Main Building / 101'),
      col('batch', 'Batch', false, 'Lab batch name. One row per batch; repeat the division columns. Blank = division only', 'A1'),
      col('batch_size', 'Batch size', false, 'Students in the batch', '20'),
    ],
    sample_rows: [
      { semester: 3, division: 'CSE-A', student_count: 60, home_room: 'Main Building / 101', batch: 'A1', batch_size: 20 },
      { semester: 3, division: 'CSE-A', student_count: 60, home_room: 'Main Building / 101', batch: 'A2', batch_size: 20 },
      { semester: 3, division: 'CSE-A', student_count: 60, home_room: 'Main Building / 101', batch: 'A3', batch_size: 20 },
    ],
  },
  offerings: {
    columns: [
      col('semester', 'Semester', true, 'Semester of the division', '3'),
      col('division', 'Division', true, 'Division name (must already exist)', 'CSE-A'),
      col('subject_code', 'Subject code', true, 'Subject code (must already exist)', 'DS'),
      col('faculty_codes', 'Faculty codes', true, 'Faculty short codes separated by | , or ; Add :assist for an assisting faculty member', 'Sharma'),
      col('batch', 'Batch', false, 'Blank = all batches of the division', ''),
      col('weekly_count', 'Sessions per week', false, 'Overrides the subject default for this division', ''),
      col('role', 'Default role', false, 'lead or assist; applies to codes without a :suffix (default lead)', 'lead'),
    ],
    sample_rows: [
      { semester: 3, division: 'CSE-A', subject_code: 'DS', faculty_codes: 'Sharma', batch: '', weekly_count: '', role: '' },
      { semester: 3, division: 'CSE-A', subject_code: 'OS', faculty_codes: 'Patil', batch: '', weekly_count: '', role: '' },
      { semester: 3, division: 'CSE-A', subject_code: 'Maths', faculty_codes: 'Kulkarni', batch: '', weekly_count: '', role: '' },
      { semester: 3, division: 'CSE-A', subject_code: 'CN', faculty_codes: 'Patil', batch: '', weekly_count: '', role: '' },
      { semester: 3, division: 'CSE-A', subject_code: 'DS Lab', faculty_codes: 'Sharma', batch: 'A1', weekly_count: '', role: '' },
      { semester: 3, division: 'CSE-A', subject_code: 'DS Lab', faculty_codes: 'Sharma|Patil:assist', batch: 'A2', weekly_count: '', role: '' },
      { semester: 3, division: 'CSE-A', subject_code: 'DS Lab', faculty_codes: 'Sharma', batch: 'A3', weekly_count: '', role: '' },
    ],
  },
};

// ---------------------------------------------------------------- value helpers

/** Lowercased, trimmed key map of a row; non-objects give {}. Spaces in headers become underscores. */
function normRow(row) {
  const out = {};
  if (!row || typeof row !== 'object' || Array.isArray(row)) return out;
  for (const k of Object.keys(row)) {
    const nk = String(k).trim().toLowerCase().replace(/\s+/g, '_');
    if (!(nk in out) || out[nk] === null) out[nk] = cell(row[k]);
  }
  return out;
}

/** Trimmed string, '' -> null; finite numbers and booleans pass through; anything else is stringified. */
function cell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'boolean') return v;
  try {
    const t = String(v).trim();
    return t === '' ? null : t;
  } catch {
    return null;
  }
}

class Collector {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }
  err(field, message) {
    this.errors.push({ field, message });
  }
  warn(field, message) {
    this.warnings.push({ field, message });
  }
}

/** Parses a whole number from 4 / "4" / "4.0". Returns {value} or {error}. null -> {value:null}. */
function parseInteger(v, { min = -Infinity, max = Infinity } = {}) {
  if (v === null || v === undefined) return { value: null };
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^[+-]?\d+(\.0*)?$/.test(v.trim())) n = Number(v.trim());
  else return { error: 'must be a whole number' };
  if (!Number.isInteger(n)) return { error: 'must be a whole number' };
  if (n < min || n > max) {
    if (min !== -Infinity && max !== Infinity) return { error: `must be between ${min} and ${max}` };
    return { error: min !== -Infinity ? `must be ${min} or more` : `must be ${max} or less` };
  }
  return { value: n };
}

function parseBool(v) {
  if (v === null || v === undefined) return { value: null };
  if (typeof v === 'boolean') return { value: v };
  const s = String(v).trim().toLowerCase();
  if (['yes', 'y', 'true', '1'].includes(s)) return { value: true };
  if (['no', 'n', 'false', '0'].includes(s)) return { value: false };
  return { error: 'must be yes, no, true, false, 1 or 0' };
}

const str = (v) => (v === null || v === undefined ? null : String(v));

/** Shortens user input before it is echoed back in a message. */
const clip = (v, n = 40) => {
  const t = String(v);
  return t.length > n ? `${t.slice(0, n)}...` : t;
};

/** Reads a required/optional string field. `max` = longest allowed length (an error row when exceeded). */
function readString(r, key, c, required, max) {
  const v = str(r[key]);
  if (v === null && required) c.err(key, `${key} is required`);
  if (v !== null && max !== undefined && v.length > max) {
    c.err(key, `${key} must be at most ${max} characters (got ${v.length})`);
  }
  return v;
}

/** An integer cell. Spread a range from limits.js (`{ min, max }`); max always defaults to the int4 safety ceiling. */
function readInt(r, key, c, { required = false, min, max = INT4_MAX } = {}) {
  const raw = r[key];
  if (raw === null || raw === undefined) {
    if (required) c.err(key, `${key} is required`);
    return null;
  }
  const res = parseInteger(raw, { min, max: Math.min(max, INT4_MAX) });
  if (res.error) {
    c.err(key, `${key} ${res.error} (got "${clip(raw)}")`);
    return null;
  }
  return res.value;
}

const MAX_KEY_ECHO = 200;
const lc = (s) => (s === null || s === undefined ? '' : String(s).trim().toLowerCase());
const collapse = (s) => String(s).trim().replace(/\s+/g, ' ');

// ---------------------------------------------------------------- ctx helpers

function lookupMap(coll) {
  const m = new Map();
  if (!coll) return m;
  const put = (k, v) => m.set(lc(k), v === undefined ? true : v);
  if (coll instanceof Map) coll.forEach((v, k) => put(k, v));
  else if (coll instanceof Set) coll.forEach((k) => put(k, true));
  else if (Array.isArray(coll)) coll.forEach((k) => typeof k === 'string' && put(k, true));
  else if (typeof coll === 'object') Object.keys(coll).forEach((k) => put(k, coll[k]));
  return m;
}

function buildCtx(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  return {
    term: c.term && typeof c.term === 'object' ? c.term : {},
    faculty: lookupMap(c.faculty),
    subjects: lookupMap(c.subjects),
    divisions: lookupMap(c.divisions),
    rooms: lookupMap(c.rooms),
    offerings: lookupMap(c.offerings),
  };
}

function idOf(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && !Array.isArray(v) && v.id !== undefined && v.id !== null) return v.id;
  return null;
}

// ---------------------------------------------------------------- per-entity row validators
// Each returns { key, normalized, errors, warnings }; cross-row checks happen afterwards.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateFaculty(r, cx) {
  const c = new Collector();
  const short_code = readString(r, 'short_code', c, true, LIMITS.short_code);
  const full_name = readString(r, 'full_name', c, true, LIMITS.full_name);
  if (short_code && /[|,;:]/.test(short_code)) c.err('short_code', 'short_code cannot contain | , ; or :');
  let email = str(r.email);
  if (email !== null) {
    email = email.toLowerCase();
    if (email.length > LIMITS.email) c.err('email', `email must be at most ${LIMITS.email} characters (got ${email.length})`);
    else if (!EMAIL_RE.test(email)) c.err('email', `email "${clip(email)}" is not a valid email address`);
  }
  const department = readString(r, 'department', c, false, LIMITS.department);
  const max_per_day = readInt(r, 'max_per_day', c, LIMITS.max_per_day);
  const max_per_week = readInt(r, 'max_per_week', c, LIMITS.max_per_week);
  if (max_per_day !== null && max_per_week !== null && max_per_day > max_per_week) {
    c.warn('max_per_day', 'max_per_day is larger than max_per_week');
  }
  const key = lc(short_code);
  return {
    key,
    errors: c.errors,
    warnings: c.warnings,
    exists: key ? cx.faculty.has(key) : false,
    normalized: { short_code, full_name, email, department, max_per_day, max_per_week },
  };
}

function validateSubject(r, cx) {
  const c = new Collector();
  const code = readString(r, 'code', c, true, LIMITS.subject_code);
  const name = readString(r, 'name', c, true, LIMITS.subject_name);
  let kind = str(r.kind);
  if (kind === null) c.err('kind', 'kind is required (theory or lab)');
  else {
    kind = kind.toLowerCase();
    if (kind !== 'theory' && kind !== 'lab') {
      c.err('kind', `kind must be theory or lab (got "${clip(r.kind)}")`);
      kind = null;
    }
  }
  const weekly_count = readInt(r, 'weekly_count', c, { required: true, ...LIMITS.weekly_count });
  const semester_total = readInt(r, 'semester_total', c, LIMITS.semester_total);
  const b = parseBool(r.allow_second_lab);
  if (b.error) c.err('allow_second_lab', `allow_second_lab ${b.error} (got "${clip(r.allow_second_lab)}")`);
  const key = lc(code);
  const exists = key ? cx.subjects.has(key) : false;
  // Blank on an existing subject = keep the stored value (null); blank on a new subject = the default.
  const allow_second_lab = b.value === null ? (exists ? null : false) : b.value;
  let duration_min = readInt(r, 'duration_min', c, LIMITS.duration_min);
  if (duration_min === null && kind && !exists) duration_min = defaultDurationFor(kind, cx.term);
  const grid = Number(cx.term.grid_minutes);
  if (duration_min !== null && Number.isFinite(grid) && grid > 0 && duration_min % grid !== 0) {
    c.warn('duration_min', `duration_min ${duration_min} is not a multiple of the ${grid}-minute grid`);
  }
  return {
    key,
    errors: c.errors,
    warnings: c.warnings,
    exists,
    normalized: { code, name, kind, weekly_count, semester_total, allow_second_lab, duration_min },
  };
}

function resolveRoom(raw, cx, c) {
  if (raw === null) return { home_room: null, home_room_id: null };
  if (String(raw).length > LIMITS.home_room) {
    c.err('home_room', `home_room must be at most ${LIMITS.home_room} characters (got ${String(raw).length})`);
    return { home_room: null, home_room_id: null };
  }
  const m = /^(.+?)\s*\/\s*(.+)$/.exec(String(raw));
  if (!m || !m[1].trim() || !m[2].trim()) {
    c.err('home_room', `home_room must look like "<building name> / <room name>" (got "${clip(raw)}")`);
    return { home_room: null, home_room_id: null };
  }
  const building = collapse(m[1]);
  const room = collapse(m[2]);
  const key = `${building.toLowerCase()} / ${room.toLowerCase()}`;
  const hit = cx.rooms.get(key);
  if (hit === undefined) {
    c.err('home_room', `Room "${building} / ${room}" was not found`);
    return { home_room: `${building} / ${room}`, home_room_id: null };
  }
  if ((Array.isArray(hit) && hit.length > 1) || (hit && typeof hit === 'object' && hit.ambiguous === true)) {
    c.err('home_room', `Room "${building} / ${room}" is ambiguous: more than one room has that name`);
    return { home_room: `${building} / ${room}`, home_room_id: null };
  }
  return { home_room: `${building} / ${room}`, home_room_id: idOf(Array.isArray(hit) ? hit[0] : hit) };
}

function validateDivisionRow(r, cx) {
  const c = new Collector();
  const semester = readInt(r, 'semester', c, { required: true, ...LIMITS.semester });
  const name = readString(r, 'division', c, true, LIMITS.division_name);
  const student_count = readInt(r, 'student_count', c, { required: true, ...LIMITS.student_count });
  const home = resolveRoom(str(r.home_room), cx, c);
  const batchName = readString(r, 'batch', c, false, LIMITS.batch_name);
  const batchSize = readInt(r, 'batch_size', c, LIMITS.batch_size);
  const divKey = semester !== null && name ? `${semester}|${lc(name)}` : '';
  // Does this batch already exist (so a blank batch_size keeps the stored size)? Needs the division's batch names in ctx.
  const divEntry = divKey ? cx.divisions.get(divKey) : undefined;
  const knownBatches = divEntry && typeof divEntry === 'object' && Array.isArray(divEntry.batches) ? divEntry.batches.map(lc) : [];
  let batch = null;
  if (batchName !== null) {
    const batchExists = knownBatches.includes(lc(batchName));
    if (batchSize === null && !batchExists && !c.errors.some((e) => e.field === 'batch_size')) {
      c.warn('batch_size', `batch ${clip(batchName)} has no batch_size; it will be recorded with 0 students`);
    }
    if (batchSize !== null && student_count !== null && batchSize > student_count) {
      c.err('batch_size', `batch_size ${batchSize} is larger than the division's student_count ${student_count}`);
    }
    if (lc(batchName) === 'all') c.err('batch', 'batch name "ALL" is reserved for the whole division');
    batch = { name: batchName, student_count: batchSize };
  } else if (batchSize !== null) {
    c.warn('batch_size', 'batch_size is ignored because batch is blank');
  }
  return {
    key: divKey,
    errors: c.errors,
    warnings: c.warnings,
    exists: divKey ? cx.divisions.has(divKey) : false,
    normalized: { semester, name, student_count, home_room: home.home_room, home_room_id: home.home_room_id, batch },
  };
}

function parseFacultyCodes(raw, defaultRole, cx, c) {
  const out = [];
  if (raw === null) {
    c.err('faculty_codes', 'faculty_codes is required');
    return out;
  }
  const parts = String(raw)
    .split(/[|,;]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) {
    c.err('faculty_codes', 'faculty_codes is required');
    return out;
  }
  if (parts.length > LIMITS.faculty_per_offering) {
    c.err('faculty_codes', `faculty_codes lists ${parts.length} people; at most ${LIMITS.faculty_per_offering} are allowed`);
    return out;
  }
  const seen = new Map();
  for (const p of parts) {
    const idx = p.lastIndexOf(':');
    let code = p;
    let role = defaultRole;
    if (idx >= 0) {
      code = p.slice(0, idx).trim();
      const suffix = p.slice(idx + 1).trim().toLowerCase();
      if (suffix === 'assist' || suffix === 'lead') role = suffix;
      else {
        c.err('faculty_codes', `Unknown role "${clip(p.slice(idx + 1).trim())}" for ${clip(code || p)}; use :lead or :assist`);
        continue;
      }
    }
    if (!code) {
      c.err('faculty_codes', `Missing faculty code in "${clip(p)}"`);
      continue;
    }
    if (code.length > LIMITS.short_code) {
      c.err('faculty_codes', `Faculty code "${clip(code)}" is longer than ${LIMITS.short_code} characters`);
      continue;
    }
    const k = lc(code);
    const hit = cx.faculty.get(k);
    if (hit === undefined) {
      c.err('faculty_codes', `Unknown faculty code "${code}"`);
      continue;
    }
    if (seen.has(k)) {
      if (seen.get(k) !== role) c.err('faculty_codes', `Faculty "${code}" is listed twice with different roles`);
      else c.warn('faculty_codes', `Faculty "${code}" is listed twice; the duplicate is ignored`);
      continue;
    }
    seen.set(k, role);
    out.push({ short_code: code, faculty_id: idOf(hit), role });
  }
  return out;
}

function validateOfferingRow(r, cx) {
  const c = new Collector();
  const semester = readInt(r, 'semester', c, { required: true, ...LIMITS.semester });
  const division = readString(r, 'division', c, true, LIMITS.division_name);
  const subject_code = readString(r, 'subject_code', c, true, LIMITS.subject_code);
  const weekly_count = readInt(r, 'weekly_count', c, LIMITS.weekly_count);
  let role = 'lead';
  if (r.role !== null && r.role !== undefined) {
    const v = String(r.role).toLowerCase();
    if (v === 'lead' || v === 'assist') role = v;
    else c.err('role', `role must be lead or assist (got "${clip(r.role)}")`);
  }
  let batch = readString(r, 'batch', c, false, LIMITS.batch_name);
  if (batch !== null && lc(batch) === 'all') batch = null;
  const faculty = parseFacultyCodes(str(r.faculty_codes), role, cx, c);

  let division_id = null;
  let subject_id = null;
  const divKey = semester !== null && division ? `${semester}|${lc(division)}` : '';
  if (divKey) {
    const d = cx.divisions.get(divKey);
    if (d === undefined) c.err('division', `Division "${clip(division)}" in semester ${semester} was not found; import divisions first`);
    else {
      division_id = idOf(d);
      const names = d && typeof d === 'object' && Array.isArray(d.batches) ? d.batches.map(lc) : null;
      if (batch !== null && names && !names.includes(lc(batch))) {
        c.err('batch', `Batch "${clip(batch)}" does not exist in division ${clip(division)}`);
      }
    }
  }
  if (subject_code) {
    const s = cx.subjects.get(lc(subject_code));
    if (s === undefined) c.err('subject_code', `Subject "${clip(subject_code)}" was not found; import subjects first`);
    else subject_id = idOf(s);
  }
  const key = divKey && subject_code ? `${divKey}|${lc(subject_code)}` : '';
  return {
    key,
    errors: c.errors,
    warnings: c.warnings,
    exists: key ? cx.offerings.has(key) : false,
    normalized: { semester, division, subject_code, subject_id, division_id, weekly_count, batch, faculty },
  };
}

// ---------------------------------------------------------------- main entry

/**
 * @param {'faculty'|'subjects'|'divisions'|'offerings'} entity
 * @param {object[]} rows
 * @param {object} ctx see the file header
 */
export function validateImportRows(entity, rows, ctx) {
  const list = Array.isArray(rows) ? rows : [];
  const e = typeof entity === 'string' ? entity.trim().toLowerCase() : '';
  if (!IMPORT_ENTITIES.includes(e)) {
    return list.map((_, i) => ({
      row: i + 1,
      status: 'error',
      errors: [{ field: 'entity', message: `Unknown import entity "${entity}"` }],
      warnings: [],
      key: '',
      normalized: null,
    }));
  }
  let cx;
  try {
    cx = buildCtx(ctx);
  } catch {
    cx = buildCtx(null);
  }

  const results = [];
  const seenKeys = new Map(); // natural key -> first row number
  const divisionState = new Map(); // divisions: divKey -> {row, student_count, home_room_key, batches: Map}
  const offeringState = new Map(); // offerings: key -> {row, weekly_count, entries: Map}

  list.forEach((raw, i) => {
    const rowNo = i + 1;
    let r;
    let isObject = raw && typeof raw === 'object' && !Array.isArray(raw);
    try {
      r = normRow(raw);
    } catch {
      r = {};
      isObject = false;
    }
    if (!isObject) {
      results.push({ row: rowNo, status: 'error', errors: [{ field: '', message: 'Row is not a valid record' }], warnings: [], key: '', normalized: null });
      return;
    }
    if (Object.values(r).every((v) => v === null)) return; // blank row

    let v;
    try {
      v = e === 'faculty' ? validateFaculty(r, cx)
        : e === 'subjects' ? validateSubject(r, cx)
          : e === 'divisions' ? validateDivisionRow(r, cx)
            : validateOfferingRow(r, cx);
    } catch (err) {
      results.push({ row: rowNo, status: 'error', errors: [{ field: '', message: 'Row could not be read' }], warnings: [], key: '', normalized: null });
      return;
    }
    const errors = [...v.errors];
    const warnings = [...v.warnings];
    const n = v.normalized;

    if (v.key && (e === 'faculty' || e === 'subjects')) {
      if (seenKeys.has(v.key)) {
        errors.push({ field: e === 'faculty' ? 'short_code' : 'code', message: `Duplicate ${e === 'faculty' ? 'short_code' : 'code'} "${e === 'faculty' ? n.short_code : n.code}": already used on row ${seenKeys.get(v.key)}` });
      } else seenKeys.set(v.key, rowNo);
    }

    if (e === 'divisions' && v.key) {
      const homeKey = n.home_room ? n.home_room.toLowerCase() : null;
      const st = divisionState.get(v.key);
      if (!st) {
        divisionState.set(v.key, { row: rowNo, student_count: n.student_count, home_room_key: homeKey, batches: new Map() });
      } else {
        if (n.student_count !== null && st.student_count !== null && n.student_count !== st.student_count) {
          errors.push({ field: 'student_count', message: `student_count ${n.student_count} conflicts with ${st.student_count} on row ${st.row} for the same division` });
        } else if (st.student_count === null) st.student_count = n.student_count;
        if (homeKey !== null && st.home_room_key !== null && homeKey !== st.home_room_key) {
          errors.push({ field: 'home_room', message: `home_room "${n.home_room}" conflicts with the home room on row ${st.row} for the same division` });
        } else if (st.home_room_key === null) st.home_room_key = homeKey;
      }
      const stNow = divisionState.get(v.key);
      const bk = n.batch ? lc(n.batch.name) : '';
      if (stNow.batches.has(bk)) {
        errors.push({ field: n.batch ? 'batch' : 'division', message: n.batch ? `Batch "${n.batch.name}" is repeated for this division (first on row ${stNow.batches.get(bk)})` : `Division "${n.name}" is repeated (first on row ${stNow.batches.get('')})` });
      } else stNow.batches.set(bk, rowNo);
    }

    if (e === 'offerings' && v.key) {
      let st = offeringState.get(v.key);
      if (!st) {
        st = { row: rowNo, weekly_count: n.weekly_count, entries: new Map() };
        offeringState.set(v.key, st);
      } else if (n.weekly_count !== null) {
        if (st.weekly_count !== null && st.weekly_count !== n.weekly_count) {
          errors.push({ field: 'weekly_count', message: `weekly_count ${n.weekly_count} disagrees with ${st.weekly_count} on row ${st.row} for the same offering` });
        } else if (st.weekly_count === null) st.weekly_count = n.weekly_count;
      }
      for (const f of n.faculty) {
        const ek = `${lc(n.batch)}\u0000${lc(f.short_code)}`;
        if (st.entries.has(ek)) {
          errors.push({ field: 'faculty_codes', message: `Faculty "${f.short_code}" is already assigned${n.batch ? ` to batch ${n.batch}` : ''} for this offering on row ${st.entries.get(ek)}` });
        } else st.entries.set(ek, rowNo);
      }
    }

    const status = errors.length ? 'error' : v.exists ? 'update' : 'create';
    // valid natural keys are far shorter than this; an over-long (rejected) value must not be echoed back as the key
    const outKey = v.key.length > MAX_KEY_ECHO ? '' : v.key;
    results.push({ row: rowNo, status, errors, warnings, key: outKey, normalized: errors.length ? null : n });
  });
  return results;
}

// ---------------------------------------------------------------- grouping helper

/**
 * Collapses validated rows into entities ready to upsert. Rows with errors are ignored.
 *   faculty / subjects -> the normalized objects
 *   divisions -> [{ semester, name, student_count, home_room, home_room_id, status,
 *                   batches: [{name, student_count}] }]
 *   offerings -> [{ semester, division, subject_code, subject_id, division_id, weekly_count, status,
 *                   faculty: [{ batch: string|null, short_code, faculty_id, role }] }]
 */
export function groupImportRows(entity, results) {
  const ok = (Array.isArray(results) ? results : []).filter((r) => r && r.status !== 'error' && r.normalized);
  const e = typeof entity === 'string' ? entity.trim().toLowerCase() : '';
  if (e === 'faculty' || e === 'subjects') return ok.map((r) => ({ ...r.normalized, status: r.status }));
  const map = new Map();
  for (const r of ok) {
    const n = r.normalized;
    let g = map.get(r.key);
    if (!g) {
      g =
        e === 'divisions'
          ? { semester: n.semester, name: n.name, student_count: n.student_count, home_room: n.home_room, home_room_id: n.home_room_id, status: r.status, batches: [] }
          : { semester: n.semester, division: n.division, subject_code: n.subject_code, subject_id: n.subject_id, division_id: n.division_id, weekly_count: n.weekly_count, status: r.status, faculty: [] };
      map.set(r.key, g);
    }
    if (e === 'divisions') {
      if (g.student_count === null) g.student_count = n.student_count;
      if (g.home_room === null) {
        g.home_room = n.home_room;
        g.home_room_id = n.home_room_id;
      }
      if (n.batch) g.batches.push({ ...n.batch });
    } else if (e === 'offerings') {
      if (g.weekly_count === null) g.weekly_count = n.weekly_count;
      for (const f of n.faculty) g.faculty.push({ batch: n.batch, short_code: f.short_code, faculty_id: f.faculty_id, role: f.role });
    }
  }
  return [...map.values()];
}
