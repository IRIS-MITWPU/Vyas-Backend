// Builds a snapshot-shaped world (term, divisions, subjects, offerings, faculty, rooms, unplaced sessions) from the
// four import CSVs and rooms_snapshot.json, WITHOUT a server. Used by the offline simulation and the tests.
// It follows contract section 2 (session expansion) and the importer rules in section 3/5. Pure.
import { cmpText } from './time.mjs';

export const DEFAULT_TERM = {
  id: 'term-1',
  academic_year: '2026-27',
  half: 'odd',
  branch: 'REAL-TEST',
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

const yes = (v) => /^(yes|true|1|y)$/i.test(String(v ?? '').trim());
const num = (v) => (String(v ?? '').trim() === '' ? null : Number(v));

/** Splits "AB|CD:assist, EF" into [{code, role}]. */
export function parseFacultyCodes(text, defaultRole = 'lead') {
  return String(text ?? '')
    .split(/[|,;]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [code, role] = x.split(':').map((y) => y.trim());
      return { code, role: role && /assist/i.test(role) ? 'assist' : defaultRole };
    });
}

/**
 * @param inputs {faculty, subjects, divisions, offerings}: arrays of CSV row objects; rooms: rooms_snapshot.json rows
 * @returns a snapshot-like object (rev 0, every session unplaced)
 */
export function buildWorld({ faculty, subjects, divisions, offerings, rooms }, termOverrides = {}) {
  const term = { ...DEFAULT_TERM, ...termOverrides };
  const fac = faculty.map((f, n) => ({
    id: `fac-${String(n + 1).padStart(4, '0')}`,
    short_code: f.short_code.trim(),
    full_name: f.full_name.trim(),
    department: f.department || null,
    max_per_day: num(f.max_per_day),
    max_per_week: num(f.max_per_week),
    is_active: true,
  }));
  const facByCode = new Map(fac.map((f) => [f.short_code.toLowerCase(), f]));

  const poolRooms = rooms
    .filter((r) => r.is_active !== false)
    .map((r, n) => ({
      id: `tr-${String(n + 1).padStart(3, '0')}`,
      room_id: `room-${String(n + 1).padStart(3, '0')}`,
      is_lab: r.room_type === 'lab',
      name: r.room,
      building_name: r.building,
      floor_number: r.floor_number,
      room_type: r.room_type,
      capacity: Number.isFinite(r.capacity) ? r.capacity : null,
    }));
  const roomByLabel = new Map(poolRooms.map((r) => [`${r.building_name} / ${r.name}`.toLowerCase(), r]));

  const subj = subjects.map((s, n) => ({
    id: `sub-${String(n + 1).padStart(3, '0')}`,
    code: s.code.trim(),
    name: s.name.trim(),
    kind: s.kind.trim(),
    duration_min: num(s.duration_min) ?? (s.kind.trim() === 'lab' ? term.lab_minutes : term.theory_minutes),
    weekly_count: Number(s.weekly_count),
    semester_total: num(s.semester_total),
    allow_second_lab: yes(s.allow_second_lab),
  }));
  const subjByCode = new Map(subj.map((s) => [s.code, s]));

  // divisions: one CSV row per batch
  const divs = [];
  const divByKey = new Map();
  for (const r of divisions) {
    const key = `${Number(r.semester)}|${r.division.trim()}`;
    let d = divByKey.get(key);
    if (!d) {
      const home = String(r.home_room ?? '').trim();
      d = {
        id: `div-${String(divs.length + 1).padStart(3, '0')}`,
        term_id: term.id,
        semester: Number(r.semester),
        name: r.division.trim(),
        student_count: Number(r.student_count),
        home_room_id: home ? roomByLabel.get(home.toLowerCase())?.room_id ?? null : null,
        batches: [],
      };
      d.batches.push({ id: `${d.id}-ALL`, division_id: d.id, name: 'ALL', student_count: d.student_count, is_whole: true });
      divs.push(d);
      divByKey.set(key, d);
    }
    const bn = String(r.batch ?? '').trim();
    if (bn && !d.batches.some((b) => b.name === bn)) {
      d.batches.push({ id: `${d.id}-${bn}`, division_id: d.id, name: bn, student_count: num(r.batch_size) ?? 0, is_whole: false });
    }
  }

  // offerings: merge rows of the same (division, subject)
  const offs = new Map();
  for (const r of offerings) {
    const d = divByKey.get(`${Number(r.semester)}|${r.division.trim()}`);
    const s = subjByCode.get(r.subject_code.trim());
    if (!d || !s) throw new Error(`offering row refers to unknown division/subject: ${JSON.stringify(r)}`);
    const k = `${d.id}|${s.id}`;
    let o = offs.get(k);
    if (!o) {
      o = {
        id: `off-${String(offs.size + 1).padStart(4, '0')}`,
        division_id: d.id,
        subject_id: s.id,
        weekly_count: null,
        per_batch: s.kind === 'lab',
        subject: { code: s.code, name: s.name, kind: s.kind },
        faculty: [],
      };
      offs.set(k, o);
    }
    if (num(r.weekly_count) !== null) o.weekly_count = num(r.weekly_count);
    const bn = String(r.batch ?? '').trim();
    const batch = bn ? d.batches.find((b) => b.name === bn) : null;
    if (bn && !batch) throw new Error(`offering row refers to unknown batch ${bn} of ${d.name}`);
    for (const { code, role } of parseFacultyCodes(r.faculty_codes, String(r.role ?? '').trim() || 'lead')) {
      const f = facByCode.get(code.toLowerCase());
      if (!f) throw new Error(`unknown faculty code ${code}`);
      const bid = batch ? batch.id : null;
      if (!o.faculty.some((x) => x.batch_id === bid && x.faculty_id === f.id)) {
        o.faculty.push({ id: `of-${o.id}-${o.faculty.length}`, batch_id: bid, faculty_id: f.id, role, short_code: f.short_code, full_name: f.full_name });
      }
    }
  }
  const offList = [...offs.values()].map((o) => {
    const s = subj.find((x) => x.id === o.subject_id);
    return { ...o, effective_weekly_count: o.weekly_count ?? s.weekly_count };
  });

  // session expansion (contract section 2)
  const sessions = [];
  for (const o of offList) {
    const s = subj.find((x) => x.id === o.subject_id);
    const d = divs.find((x) => x.id === o.division_id);
    const nonWhole = d.batches.filter((b) => !b.is_whole);
    const targets = o.per_batch ? (nonWhole.length ? nonWhole : d.batches.filter((b) => b.is_whole)) : d.batches.filter((b) => b.is_whole);
    for (const b of targets) {
      for (let seq = 1; seq <= o.effective_weekly_count; seq++) {
        const facs = o.faculty.filter((f) => f.batch_id === b.id || f.batch_id === null);
        sessions.push({
          id: `ses-${String(sessions.length + 1).padStart(5, '0')}`,
          offering_id: o.id,
          batch_id: b.id,
          seq,
          weekday: null,
          start_min: null,
          end_min: null,
          room_id: null,
          locked: false,
          subject_code: s.code,
          subject_name: s.name,
          kind: s.kind,
          duration_min: s.duration_min,
          batch_name: b.name,
          faculty: facs.map((f) => ({ faculty_id: f.faculty_id, short_code: f.short_code, full_name: f.full_name })),
        });
      }
    }
  }
  sessions.sort((a, b) => cmpText(a.id, b.id));
  return {
    success: true,
    rev: 0,
    version: { id: 'ver-1', term_id: term.id, version_no: 1, status: 'draft' },
    term,
    divisions: divs,
    subjects: subj,
    offerings: offList,
    faculty: fac,
    rooms: poolRooms,
    sessions,
  };
}
