// Helpers for the offline unit tests (not a test file). Builds small snapshot-shaped worlds with buildWorld().
import { buildWorld } from './world.mjs';

/**
 * mini({rooms, faculty, subjects, divisions, offerings, term})
 *  rooms:     [{name, lab?:bool, cap?:number|null, building?}]
 *  faculty:   ['A','B',...]
 *  subjects:  [{code, kind:'theory'|'lab', weekly, dur?}]
 *  divisions: [{name, students, batches?:[[name,size],...], home?:roomName, sem?:3}]
 *  offerings: [{div, code, faculty:'A|B', batch?, weekly?}]   (one row per CSV row)
 */
export function mini({ rooms = [], faculty = [], subjects = [], divisions = [], offerings = [], term = {} }) {
  return buildWorld(
    {
      faculty: faculty.map((c) => ({ short_code: c, full_name: `Prof ${c}`, email: '', department: '', max_per_day: '', max_per_week: '' })),
      subjects: subjects.map((s) => ({ code: s.code, name: s.code, kind: s.kind, weekly_count: String(s.weekly), semester_total: '', allow_second_lab: 'no', duration_min: s.dur ? String(s.dur) : '' })),
      divisions: divisions.flatMap((d) => {
        const base = { semester: String(d.sem ?? 3), division: d.name, student_count: String(d.students), home_room: d.home ? `Vyas / ${d.home}` : '' };
        return d.batches?.length ? d.batches.map(([b, n]) => ({ ...base, batch: b, batch_size: String(n) })) : [{ ...base, batch: '', batch_size: '' }];
      }),
      offerings: offerings.map((o) => ({ semester: String(o.sem ?? 3), division: o.div, subject_code: o.code, faculty_codes: o.faculty, batch: o.batch ?? '', weekly_count: o.weekly ? String(o.weekly) : '', role: '' })),
      rooms: rooms.map((r, n) => ({ building: r.building ?? 'Vyas', floor_number: 0, room: r.name, room_type: r.lab ? 'lab' : 'classroom', capacity: r.cap === undefined ? 60 : r.cap, is_active: true })),
    },
    term,
  );
}

/** Returns the session of a world by (division name, subject code, batch name | 'ALL', seq). */
export function sessionOf(world, division, code, batch = 'ALL', seq = 1) {
  const d = world.divisions.find((x) => x.name === division);
  const b = d.batches.find((x) => x.name === batch);
  const s = world.sessions.find((x) => x.batch_id === b.id && x.subject_code === code && x.seq === seq);
  if (!s) throw new Error(`no session ${division}/${code}/${batch}/${seq}`);
  return s;
}

export const roomId = (world, name) => world.rooms.find((r) => r.name === name).room_id;

/** Marks a session of the snapshot as placed (mutates the snapshot; for building fixtures). */
export function placeIn(world, session, weekday, start, room) {
  session.weekday = weekday;
  session.start_min = start;
  session.end_min = start + session.duration_min;
  session.room_id = room;
  return session;
}
