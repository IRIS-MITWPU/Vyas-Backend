// READ-ONLY helper: snapshots building / floor / room names from the local Vyas DB into rooms_snapshot.json
// so that build_real_inputs.py and check_real_inputs.mjs can run offline and deterministically.
// Run from Vyas-Backend:  node tests/planner/fixtures/real/fetch_rooms.mjs
// Refuses to run unless DB_HOST=localhost. Issues one SELECT, never prints credentials.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { default: pool } = await import(new URL('../../../../database/db.js', import.meta.url));

if (process.env.DB_HOST !== 'localhost') {
  console.error('Refusing to run: DB_HOST is not localhost');
  await pool.end();
  process.exit(1);
}
const { rows } = await pool.query(
  `SELECT b.name AS building, f.floor_number, r.name AS room, r.room_type, r.capacity, r.is_active
     FROM rooms r JOIN floors f ON f.id = r.floor_id JOIN buildings b ON b.id = f.building_id
    ORDER BY b.name, f.floor_number, r.name`
);
writeFileSync(path.join(here, 'rooms_snapshot.json'), JSON.stringify(rows, null, 1) + '\n', 'utf8');
console.log(`rooms_snapshot.json written: ${rows.length} rooms`);
await pool.end();
