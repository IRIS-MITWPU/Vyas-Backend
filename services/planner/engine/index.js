// Public surface of the timetable generator engine (contract 9). Pure modules, no DB and no I/O.
export { generate, GenerationCancelled, MODES, sessionKey } from './generate.js';
export { buildEngineConfig, defaultEngineConfig, BASE_WEIGHTS, PARAM_DEFAULTS } from './config.js';
export { OccupancyModel, buildModel, buildSessionInfo } from './model.js';
export { candidatesFor, suggestionsFor } from './suggest.js';
export { diagnose, hasPolicyCandidate, slotCounts, facultyLabel } from './diagnose.js';
export { repairUnplaced } from './repair.js';
export { theoryCandidates, labBlockCandidates, divisionOrder, facultyLoads, labStartPenalty, WEIGHTS, DEFAULTS } from './rank.js';
export { latinRounds, buildLabBlocks } from './rotation.js';
