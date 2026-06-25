// services/conflictDetector.js

/**
 * Run all conflict checks on lectures within a job.
 * Returns array of conflict objects (not yet saved to DB — caller saves them).
 */
export function detectConflicts(lectures) {
  const conflicts = [];

  conflicts.push(...detectMissingFields(lectures));
  conflicts.push(...detectRoomClashes(lectures));
  conflicts.push(...detectFacultyClashes(lectures));
  conflicts.push(...detectDuplicates(lectures));

  return conflicts;
}

function detectMissingFields(lectures) {
  return lectures
    .filter((l) => l.missing_fields && l.missing_fields.length > 0)
    .map((l) => ({
      conflict_type: 'MISSING_FIELD',
      severity: 'WARNING',
      lecture_ids: [l.id],
      description: `Missing required fields: ${l.missing_fields.join(', ')}`,
    }));
}

function detectRoomClashes(lectures) {
  const conflicts = [];
  const valid = lectures.filter(
    (l) => l.room_number && l.weekday_number && l.start_time && l.duration_minutes
  );

  const grouped = groupBy(valid, (l) => `${l.room_number}__${l.weekday_number}`);

  for (const group of Object.values(grouped)) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (timesOverlap(group[i], group[j])) {
          conflicts.push({
            conflict_type: 'ROOM_CLASH',
            severity: 'ERROR',
            lecture_ids: [group[i].id, group[j].id],
            description:
              `Room ${group[i].room_number} is double-booked on ` +
              `${weekdayName(group[i].weekday_number)} at ` +
              `${group[i].start_time} (${group[i].subject}) and ${group[j].start_time} (${group[j].subject})`,
          });
        }
      }
    }
  }
  return conflicts;
}

function detectFacultyClashes(lectures) {
  const conflicts = [];
  const valid = lectures.filter(
    (l) => l.teacher_name && l.weekday_number && l.start_time && l.duration_minutes
  );

  // Normalize teacher names for comparison
  const normalized = valid.map((l) => ({
    ...l,
    _normalizedTeacher: l.teacher_name.toLowerCase().replace(/\b(dr|prof|mr|mrs|ms)\.?\s*/gi, '').trim(),
  }));

  const grouped = groupBy(normalized, (l) => `${l._normalizedTeacher}__${l.weekday_number}`);

  for (const group of Object.values(grouped)) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (timesOverlap(group[i], group[j])) {
          conflicts.push({
            conflict_type: 'FACULTY_CLASH',
            severity: 'ERROR',
            lecture_ids: [group[i].id, group[j].id],
            description:
              `${group[i].teacher_name} is scheduled for two lectures simultaneously on ` +
              `${weekdayName(group[i].weekday_number)}: "${group[i].subject}" and "${group[j].subject}"`,
          });
        }
      }
    }
  }
  return conflicts;
}

function detectDuplicates(lectures) {
  const conflicts = [];
  const seen = new Map();

  for (const l of lectures) {
    const key = [l.teacher_name, l.subject, l.room_number, l.weekday_number, l.start_time]
      .map((v) => String(v || '').toLowerCase().trim())
      .join('__');

    if (seen.has(key)) {
      conflicts.push({
        conflict_type: 'DUPLICATE',
        severity: 'WARNING',
        lecture_ids: [seen.get(key), l.id],
        description: `Duplicate entry: "${l.subject}" with ${l.teacher_name} on ${weekdayName(l.weekday_number)} at ${l.start_time}`,
      });
    } else {
      seen.set(key, l.id);
    }
  }
  return conflicts;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function toMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function timesOverlap(a, b) {
  const aStart = toMinutes(a.start_time);
  const aEnd = aStart + a.duration_minutes;
  const bStart = toMinutes(b.start_time);
  const bEnd = bStart + b.duration_minutes;
  return aStart < bEnd && bStart < aEnd;
}

function groupBy(arr, keyFn) {
  return arr.reduce((acc, item) => {
    const k = keyFn(item);
    (acc[k] = acc[k] || []).push(item);
    return acc;
  }, {});
}

const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function weekdayName(n) {
  return DAYS[n] || `Day ${n}`;
}
