// Deterministic, fast verification of the total-failure fix: with a garbage
// API key, every chunk fails immediately (auth errors aren't retryable, so
// no backoff wait) — proves extractLecturesFromText now returns
// {lectures: [], failedChunks: [...]} instead of throwing, without needing
// to wait on real Gemini flakiness again.
process.env.GEMINI_API_KEY = 'invalid-key-for-testing-failure-path';
process.env.LLM_RETRY_COUNT = '1'; // keep it fast — 1 attempt per chunk

const { extractLecturesFromText } = await import('../services/llmService.js');

const fakeText = 'Sheet: Test\n'.repeat(1) + 'Monday | 9.00 | Test Subject\n'.repeat(400); // forces >1 chunk

try {
  const result = await extractLecturesFromText(fakeText, null, {});
  console.log('RESULT (no exception thrown):');
  console.log('  lectures.length:', result.lectures.length);
  console.log('  failedChunks.length:', result.failedChunks.length);
  console.log('  failedChunks[0]:', JSON.stringify({ ...result.failedChunks[0], chunkText: `<${result.failedChunks[0].chunkText.length} chars>` }));
  if (result.lectures.length === 0 && result.failedChunks.length > 0) {
    console.log('\nPASS: total-failure case returns structured failedChunks instead of throwing.');
    process.exit(0);
  } else {
    console.log('\nUNEXPECTED shape — investigate.');
    process.exit(1);
  }
} catch (err) {
  console.error('FAIL: extractLecturesFromText threw instead of returning failedChunks:', err.message);
  process.exit(1);
}
