// Minimal API client for the planner with polite 429 handling. No dependencies, no DB / Redis access.
// Never logs the cookie or any header value except the retry hints.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Seconds to wait after a 429 from the response headers (Retry-After, RateLimit-Reset, RateLimit: ...;reset=N), else 60. */
export function retryAfterSeconds(headers, fallback = 60) {
  const get = (n) => (typeof headers?.get === 'function' ? headers.get(n) : headers?.[n]);
  const ra = get('retry-after');
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n)) return Math.max(1, Math.ceil(n));
    const t = Date.parse(ra);
    if (Number.isFinite(t)) return Math.max(1, Math.ceil((t - Date.now()) / 1000));
  }
  const reset = get('ratelimit-reset');
  if (reset && Number.isFinite(Number(reset))) return Math.max(1, Math.ceil(Number(reset)));
  const combined = get('ratelimit');
  const m = combined && /reset=(\d+)/i.exec(combined);
  if (m) return Math.max(1, Number(m[1]));
  return fallback;
}

/**
 * createApi({baseUrl, cookie, onWait, maxWaitSeconds, maxRetries}) -> {request(method, path, body), get, post, put, del, count}
 * `path` is relative to /planner (e.g. "/terms"). Returns {status, body, headers}; never throws on HTTP errors,
 * only on network failures (after two retries) or when a 429 persists after maxRetries waits.
 */
/** One line describing the limiter headers of the first response (no secrets in there). */
export function describeRateInfo(info) {
  if (!info || (!info.limit && !info.policy && !info.combined)) return 'rate limit headers: none seen';
  return `rate limit headers: limit=${info.limit ?? '?'} remaining=${info.remaining ?? '?'} reset=${info.reset ?? '?'}s policy=${info.policy ?? info.combined ?? '?'}`;
}

export function createApi({ baseUrl, cookie, onWait = () => {}, maxWaitSeconds = 20 * 60, maxRetries = 8, fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const api = { count: 0, waited_seconds: 0, rateInfo: null };
  async function request(method, path, body) {
    let rateLimited = 0;
    let netErrors = 0;
    for (;;) {
      api.count += 1;
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/planner${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', Origin: baseUrl, ...(cookie ? { Cookie: cookie } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (++netErrors <= 2) {
          await sleepImpl(500 * netErrors);
          continue;
        }
        throw new Error(`network error calling ${method} /planner${path}: ${err?.cause?.code ?? err?.message ?? err}`);
      }
      if (res.status === 429) {
        if (++rateLimited > maxRetries) throw new Error(`still rate limited after ${maxRetries} waits (${method} /planner${path})`);
        const secs = Math.min(retryAfterSeconds(res.headers), maxWaitSeconds);
        onWait(secs, `${method} /planner${path}`);
        api.waited_seconds += secs;
        await sleepImpl(secs * 1000 + 250);
        continue;
      }
      if (!api.rateInfo) {
        const h = (n) => res.headers?.get?.(n) ?? null;
        api.rateInfo = { limit: h('ratelimit-limit'), remaining: h('ratelimit-remaining'), reset: h('ratelimit-reset'), policy: h('ratelimit-policy'), combined: h('ratelimit') };
      }
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: res.status, body: json, headers: res.headers };
    }
  }
  api.request = request;
  api.get = (p) => request('GET', p);
  api.post = (p, b) => request('POST', p, b ?? {});
  api.put = (p, b) => request('PUT', p, b ?? {});
  api.del = (p) => request('DELETE', p);
  return api;
}
