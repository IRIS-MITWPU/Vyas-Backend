/**
 * Plain-English explanations for clashes. Pure, no I/O, never throws.
 */

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Minutes since midnight -> "09:30". Invalid input -> "--:--". */
export function fmtTime(min) {
  if (typeof min !== 'number' || !Number.isFinite(min)) return '--:--';
  const m = Math.floor(min);
  const h = Math.floor(m / 60);
  const mm = ((m % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** 0 -> "Monday" ... 6 -> "Sunday"; anything else -> "Day <n>". */
export function weekdayName(n) {
  if (Number.isInteger(n) && n >= 0 && n <= 6) return WEEKDAYS[n];
  return `Day ${n}`;
}

/** "09:30–10:30" (en dash). */
export function fmtRange(start_min, end_min) {
  return `${fmtTime(start_min)}–${fmtTime(end_min)}`;
}

function has(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

/** "CSE-B (Sem 3)" */
function divisionLabel(h) {
  const name = has(h.division_name) ? String(h.division_name) : 'a division';
  return has(h.semester) ? `${name} (Sem ${h.semester})` : name;
}

/** " batch A1" when the holder is a sub-batch session, otherwise "". */
function batchSuffix(h) {
  return h.is_whole === false && has(h.batch_name) ? ` batch ${h.batch_name}` : '';
}

function subjectLabel(h) {
  if (has(h.subject_code)) return String(h.subject_code);
  if (has(h.subject_name)) return String(h.subject_name);
  return 'another session';
}

/**
 * One sentence describing why a slot is taken.
 * kind: 'faculty' | 'room' | 'batch'. resourceName is already formatted by the caller.
 * holder: {subject_code, subject_name, division_name, semester, batch_name, is_whole}
 */
export function describeConflict(input) {
  const { kind, resourceName, holder, weekday, start_min, end_min } = input || {};
  const h = holder && typeof holder === 'object' ? holder : {};
  const when = `${weekdayName(weekday)} ${fmtRange(start_min, end_min)}`;
  const res = has(resourceName) ? String(resourceName) : 'This resource';
  const subj = subjectLabel(h);
  const div = divisionLabel(h);
  const batch = batchSuffix(h);

  if (kind === 'faculty') {
    return `${res} is already teaching ${subj} to ${div}${batch} on ${when}.`;
  }
  if (kind === 'room') {
    return `Room ${res} is already used by ${subj} for ${div}${batch} on ${when}.`;
  }
  if (kind === 'batch') {
    return `${div}${batch} already has ${subj} on ${when}.`;
  }
  return `${res} is already booked by ${subj} on ${when}.`;
}

/** "LB for CSE-A (Sem 3) batch A1 (30 students)" */
function holderLabel(h) {
  const n = typeof h.students === 'number' && Number.isFinite(h.students) ? h.students : null;
  const count = n === null ? '' : ` (${n} student${n === 1 ? '' : 's'})`;
  return `${subjectLabel(h)} for ${divisionLabel(h)}${batchSuffix(h)}${count}`;
}

/**
 * Sentence for a shared lab room that is too full (contract 8.7.3), e.g.
 * "Room VY 027 (capacity 62) would hold 90 students on Monday 08:30–10:30; it already has LB for CSE-A (Sem 3)
 *  batch A1 (30 students) and LB for CSE-B (Sem 3) batch B1 (30 students)."
 * input: {roomName, capacity, peak, weekday, start_min, end_min, holders:[{subject_code, subject_name,
 *         division_name, semester, batch_name, is_whole, students}]}
 */
export function describeCapacity(input) {
  const { roomName, capacity, peak, weekday, start_min, end_min, holders } = input || {};
  const when = `${weekdayName(weekday)} ${fmtRange(start_min, end_min)}`;
  const res = has(roomName) ? String(roomName) : 'This room';
  const cap = typeof capacity === 'number' && Number.isFinite(capacity) ? ` (capacity ${capacity})` : '';
  const total = typeof peak === 'number' && Number.isFinite(peak) ? peak : '?';
  const list = (Array.isArray(holders) ? holders : []).filter((h) => h && typeof h === 'object').map(holderLabel);
  const head = `Room ${res}${cap} would hold ${total} students on ${when}`;
  if (!list.length) return `${head}.`;
  const joined = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `${head}; it already has ${joined}.`;
}
