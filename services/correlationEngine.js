// services/correlationEngine.js
import stringSimilarity from 'string-similarity';

/**
 * When multiple files are in one import job, try to merge partial records.
 * Example: File A has teacher+time, File B has same subject+room.
 * We merge on subject similarity + weekday + time.
 */
export function correlateLectures(lecturesByFile) {
  // Flatten all lectures with their source file
  const all = lecturesByFile.flatMap((fileLectures, fileIndex) =>
    fileLectures.map((l) => ({ ...l, _fileIndex: fileIndex }))
  );

  // If only one file, nothing to correlate
  if (lecturesByFile.length <= 1) return { merged: all, warnings: [] };

  const merged = [];
  const used = new Set();
  const warnings = [];

  for (let i = 0; i < all.length; i++) {
    if (used.has(i)) continue;
    const a = all[i];
    let bestMatch = null;
    let bestScore = 0;

    for (let j = i + 1; j < all.length; j++) {
      if (used.has(j)) continue;
      if (all[j]._fileIndex === a._fileIndex) continue; // same file, skip

      const b = all[j];
      const score = matchScore(a, b);
      if (score > bestScore && score >= 0.85) {
        bestScore = score;
        bestMatch = j;
      }
    }

    if (bestMatch !== null) {
      const b = all[bestMatch];
      const mergeResult = mergeLectures(a, b);
      if (mergeResult.conflict) {
        warnings.push(mergeResult.conflict);
      }
      merged.push(mergeResult.lecture);
      used.add(i);
      used.add(bestMatch);
    } else {
      merged.push(a);
      used.add(i);
    }
  }

  return { merged, warnings };
}

function matchScore(a, b) {
  let score = 0;
  let factors = 0;

  // Subject similarity (most important)
  if (a.subject && b.subject) {
    const sim = stringSimilarity.compareTwoStrings(a.subject.toLowerCase(), b.subject.toLowerCase());
    score += sim * 0.6;
    factors += 0.6;
  }

  // Same weekday
  if (a.weekday_number && b.weekday_number) {
    score += (a.weekday_number === b.weekday_number ? 1 : 0) * 0.25;
    factors += 0.25;
  }

  // Same start time
  if (a.start_time && b.start_time) {
    score += (a.start_time === b.start_time ? 1 : 0) * 0.15;
    factors += 0.15;
  }

  return factors > 0 ? score / factors : 0;
}

function mergeLectures(a, b) {
  const merged = { ...a };
  const conflicts = [];

  const fields = [
    'teacher_name', 'subject', 'room_number', 'weekday_number',
    'start_time', 'duration_minutes', 'batch', 'lecture_type',
  ];

  for (const field of fields) {
    if (!merged[field] && b[field]) {
      merged[field] = b[field]; // fill null from other file
    } else if (merged[field] && b[field] && merged[field] !== b[field]) {
      conflicts.push(`Field "${field}" conflicts: "${merged[field]}" vs "${b[field]}"`);
    }
  }

  return {
    lecture: merged,
    conflict: conflicts.length > 0 ? conflicts.join('; ') : null,
  };
}
