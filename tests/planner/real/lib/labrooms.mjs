// Lab room affinity: subject -> division -> batch -> workbook room codes (lab_rooms.json) mapped to pool rooms. Pure.
//
// lab_rooms.json[<lab subject code>][<division name>][<batch | '*'>] = ['VY027', ...]
// _room_mapping maps a workbook code to '<building> / <room name>' (or null when the room is not in the Vyas rooms table).

/**
 * @param labRooms  parsed lab_rooms.json
 * @param poolRooms snapshot.rooms (term pool rows: room_id, name, building_name)
 * @returns {{roomsFor(info): string[]|null, stats}}  roomsFor returns pool room ids (rooms.id) in preference order, or null when the
 *          subject/division has no usable room (the engine then lets the server auto-pick).
 */
export function makeAffinityLookup(labRooms, poolRooms) {
  const mapping = labRooms?._room_mapping ?? {};
  const byLabel = new Map(poolRooms.map((r) => [`${r.building_name} / ${r.name}`.toLowerCase(), r.room_id ?? r.id]));
  const idOfCode = (code) => {
    const label = mapping[code];
    return label ? byLabel.get(String(label).toLowerCase()) ?? null : null;
  };
  const stats = { codes_total: 0, codes_mapped: 0, unmapped_codes: new Set() };
  const roomsFor = (info) => {
    const entry = labRooms?.[info.subject_code]?.[String(info.division_key).split('|').slice(1).join('|')];
    if (!entry) return null;
    const codes = [...(entry[info.batch_name] ?? []), ...(entry['*'] ?? [])];
    const ids = [];
    for (const c of codes) {
      stats.codes_total += 1;
      const id = idOfCode(c);
      if (id) {
        stats.codes_mapped += 1;
        if (!ids.includes(id)) ids.push(id);
      } else stats.unmapped_codes.add(c);
    }
    return ids.length ? ids : null;
  };
  return { roomsFor, stats };
}
