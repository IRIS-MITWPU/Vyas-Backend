// Throwaway verification script for the LLM import reliability guide's
// Phase 1 (error-aware bounded retry) and Phase 2 (mid-request cancellation).
// Mocks the Gemini call directly — no real API calls, no DB, no queue.
import {
  isRetryable,
  callWithTimeout,
  callWithRetry,
  extractLecturesFromText,
  computeJobDeadlineMs,
} from '../services/llmService.js';
import { registerAbortController, abortActiveCall } from '../services/importAbortRegistry.js';
import { classifyFailure, FAILURE_CODES } from '../services/importProgress.js';

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    failures++;
    console.log(`FAIL: ${label}`);
  }
}

// ── isRetryable classification ──────────────────────────────────────────
{
  const err504 = Object.assign(new Error('x'), { status: 504 });
  const err429 = Object.assign(new Error('x'), { status: 429 });
  const err400 = Object.assign(new Error('x'), { status: 400 });
  const errTimeout = Object.assign(new Error('x'), { name: 'TimeoutError' });
  const errCancelled = Object.assign(new Error('x'), { name: 'UserCancelledError' });
  const errConnReset = Object.assign(new Error('x'), { code: 'ECONNRESET' });

  assert(isRetryable(err504) === true, 'isRetryable: 504 is retryable');
  assert(isRetryable(err429) === true, 'isRetryable: 429 is retryable');
  assert(isRetryable(err400) === false, 'isRetryable: 400 is terminal');
  assert(isRetryable(errTimeout) === true, 'isRetryable: TimeoutError is retryable');
  assert(isRetryable(errCancelled) === false, 'isRetryable: UserCancelledError is terminal');
  assert(isRetryable(errConnReset) === true, 'isRetryable: ECONNRESET is retryable');
}

// ── Phase 1: terminal error fails after 1 attempt, not maxAttempts ──────
{
  let calls = 0;
  const terminalFn = async () => {
    calls++;
    throw Object.assign(new Error('bad request'), { status: 400 });
  };
  try {
    await callWithRetry(terminalFn, { maxAttempts: 3, baseDelayMs: 10 });
    assert(false, 'Phase 1: terminal error should have thrown');
  } catch (err) {
    assert(calls === 1, `Phase 1: terminal error stops after 1 attempt (got ${calls})`);
  }
}

// ── Phase 1: retryable error retries up to maxAttempts ──────────────────
{
  let calls = 0;
  const retryableFn = async () => {
    calls++;
    throw Object.assign(new Error('server error'), { status: 503 });
  };
  try {
    await callWithRetry(retryableFn, { maxAttempts: 3, baseDelayMs: 10 });
    assert(false, 'Phase 1: retryable error should have thrown after exhausting retries');
  } catch (err) {
    assert(calls === 3, `Phase 1: retryable error retries maxAttempts times (got ${calls})`);
    assert(err.attempts === 3, `Phase 1: error tagged with attempts=3 (got ${err.attempts})`);
  }
}

// ── Phase 1: retryable error succeeds on a later attempt ────────────────
{
  let calls = 0;
  const flakyFn = async () => {
    calls++;
    if (calls < 2) throw Object.assign(new Error('transient'), { status: 503 });
    return 'ok';
  };
  const result = await callWithRetry(flakyFn, { maxAttempts: 3, baseDelayMs: 10 });
  assert(result === 'ok' && calls === 2, `Phase 1: succeeds on 2nd attempt after transient failure (got calls=${calls})`);
}

// ── Phase 2: callWithTimeout distinguishes timeout vs external cancel ───
{
  // Simulate a call that hangs forever until aborted, and never resolves
  // on its own — this is exactly the original bug's shape.
  const hangingFn = (signal) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });

  // Case A: external cancellation via the abort registry, well before any
  // internal timeout would fire.
  const jobIdA = 'test-job-cancel';
  const callPromise = callWithTimeout(hangingFn, { jobId: jobIdA });
  // registerAbortController is called inside callWithTimeout itself, so we
  // need a moment for that to happen before we can abort it externally.
  await new Promise((r) => setTimeout(r, 50));
  const start = Date.now();
  const aborted = abortActiveCall(jobIdA, 'test cancellation');
  try {
    await callPromise;
    assert(false, 'Phase 2: cancelled call should have thrown');
  } catch (err) {
    const elapsed = Date.now() - start;
    assert(aborted === true, 'Phase 2: abortActiveCall found and aborted the controller');
    assert(err.name === 'UserCancelledError', `Phase 2: cancelled call tagged UserCancelledError (got ${err.name})`);
    assert(elapsed < 1000, `Phase 2: cancellation took effect within 1s (took ${elapsed}ms)`);
    assert(isRetryable(err) === false, 'Phase 2: UserCancelledError is not retryable');
  }
}

// ── Phase 2: callWithTimeout's own internal timeout fires and is tagged TimeoutError ──
{
  const hangingFn = (signal) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  const start = Date.now();
  try {
    await callWithTimeout(hangingFn, { timeoutMs: 200 });
    assert(false, 'Phase 2: internal timeout should have thrown');
  } catch (err) {
    const elapsed = Date.now() - start;
    assert(err.name === 'TimeoutError', `Phase 2: internal timeout tagged TimeoutError (got ${err.name})`);
    assert(elapsed >= 190 && elapsed < 1000, `Phase 2: internal timeout fired around 200ms (took ${elapsed}ms)`);
    assert(isRetryable(err) === true, 'Phase 2: TimeoutError is retryable');
  }
}

// ── Phase 4: classifyFailure maps error shapes to the right failureCode ──
{
  const cases = [
    [Object.assign(new Error('x'), { name: 'UserCancelledError' }), FAILURE_CODES.JOB_CANCELLED_BY_USER],
    [Object.assign(new Error('x'), { name: 'TimeoutError' }), FAILURE_CODES.LLM_TIMEOUT],
    [Object.assign(new Error('x'), { name: 'DeadlineExceededError' }), FAILURE_CODES.JOB_DEADLINE_EXCEEDED],
    [new Error('LLM extraction failed after 3 attempts: x'), FAILURE_CODES.LLM_RETRIES_EXHAUSTED],
    [new Error('LLM returned invalid JSON: xyz'), FAILURE_CODES.PARSING_ERROR],
    [Object.assign(new Error('x'), { code: 'ECONNRESET' }), FAILURE_CODES.REDIS_ERROR],
    [Object.assign(new Error('bad request'), { status: 400, retryable: false }), FAILURE_CODES.LLM_PROVIDER_ERROR],
    [new Error('totally unrelated'), FAILURE_CODES.UNKNOWN],
  ];
  for (const [err, expected] of cases) {
    const got = classifyFailure(err);
    assert(got === expected, `Phase 4: classifyFailure(${err.name || err.message}) === ${expected} (got ${got})`);
  }
}

// ── Phase 5: computeJobDeadlineMs scales with file count and is positive ──
{
  const oneFile = computeJobDeadlineMs(1);
  const threeFiles = computeJobDeadlineMs(3);
  assert(oneFile > 0, `Phase 5: deadline for 1 file is positive (got ${oneFile})`);
  assert(threeFiles > oneFile, `Phase 5: deadline scales up with more files (1file=${oneFile}, 3files=${threeFiles})`);
}

// ── Phase 5: extractLecturesFromText throws DeadlineExceededError once the deadline has passed ──
{
  const pastDeadline = Date.now() - 1000; // already in the past
  try {
    await extractLecturesFromText('Sheet: X\nsome row\nanother row', null, { deadlineAt: pastDeadline });
    assert(false, 'Phase 5: should have thrown DeadlineExceededError');
  } catch (err) {
    assert(err.name === 'DeadlineExceededError', `Phase 5: past deadline throws DeadlineExceededError (got ${err.name})`);
    assert(classifyFailure(err) === FAILURE_CODES.JOB_DEADLINE_EXCEEDED, 'Phase 5: classifies as JOB_DEADLINE_EXCEEDED');
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
