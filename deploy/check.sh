#!/usr/bin/env bash
# Go/no-go gate after every deploy (plan 8.1). Exits non-zero if any check fails.
#   deploy/check.sh                        # inspects the running compose stack (run from the repo dir)
#   APP_LOG=a.txt WORKER_LOG=w.txt deploy/check.sh --logs-only   # log checks on files (used by the tests)
set -uo pipefail

FAILS=0
ok()   { echo "  ok    $*"; }
fail() { echo "  FAIL  $*"; FAILS=$((FAILS + 1)); }

# ---- log checks -------------------------------------------------------------
check_logs() {
  local app="$1" worker="$2"

  grep -q "Socket.IO using Redis adapter" "$app" \
    && ok "Socket.IO uses the Redis adapter" || fail "missing 'Socket.IO using Redis adapter'"
  grep -q "in-memory adapter" "$app" \
    && fail "Socket.IO fell back to the in-memory adapter" || ok "no in-memory adapter warning"

  # If this shows up the rate limiter is silently OFF: do not proceed.
  grep -q "async error during store initialization" "$app" "$worker" \
    && fail "rate limiter store failed to initialise (rate limiting is OFF)" || ok "rate limiter initialised"

  grep -q "Background workers disabled" "$app" \
    && ok "app runs no background workers" || fail "app did not log 'Background workers disabled' (RUN_WORKERS must be false)"
  grep -q "Email worker started" "$worker" \
    && ok "email worker started in worker" || fail "worker did not start the email worker"
  grep -q "Timetable import worker started" "$worker" \
    && ok "import worker started in worker" || fail "worker did not start the import worker"
  grep -q "Email worker started\|Timetable import worker started" "$app" \
    && fail "a background worker started inside app" || ok "no background worker inside app"

  local loops
  loops=$(cat "$app" "$worker" | grep -c -i "ECONNREFUSED\|ECONNRESET\|Unexpected PG pool error\|Error connecting to DB\|Redis.*error\|reconnect")
  [ "$loops" -le 3 ] && ok "no reconnect loops ($loops matching lines)" || fail "$loops Redis/DB error or reconnect lines (loop?)"
}

if [ "${1:-}" = "--logs-only" ]; then
  check_logs "${APP_LOG:?APP_LOG file}" "${WORKER_LOG:?WORKER_LOG file}"
  echo; [ "$FAILS" -eq 0 ] && echo "GO" || { echo "NO-GO ($FAILS failed)"; exit 1; }
  exit 0
fi

# ---- container checks -------------------------------------------------------
COMPOSE=${COMPOSE:-"docker compose"}
: "${TAG:?set TAG (the image tag that is deployed)}"
cid() { $COMPOSE ps -aq "$1"; } # -a: a stopped container is reported as failed, not "missing"

APP_ID=$(cid app); WORKER_ID=$(cid worker); REDIS_ID=$(cid redis)
[ -n "$APP_ID" ] && [ -n "$WORKER_ID" ] && [ -n "$REDIS_ID" ] || { echo "app/worker/redis containers not all present"; exit 1; }

state() { docker inspect -f "$2" "$1"; }

# After `up -d` the app needs its start_period + first probe: wait (WAIT_SECS) before judging it.
waited=0
while [ "$(state "$APP_ID" '{{.State.Health.Status}}')" != healthy ] && [ "$waited" -lt "${WAIT_SECS:-0}" ]; do
  sleep 3; waited=$((waited + 3))
done
[ "$(state "$APP_ID" '{{.State.Health.Status}}')" = healthy ]   && ok "app healthy"   || fail "app not healthy"
[ "$(state "$REDIS_ID" '{{.State.Health.Status}}')" = healthy ] && ok "redis healthy" || fail "redis not healthy"
# worker has no port/healthcheck: healthy == running and never restarted
[ "$(state "$WORKER_ID" '{{.State.Running}}')" = true ] && [ "$(state "$WORKER_ID" '{{.RestartCount}}')" = 0 ] \
  && ok "worker running, 0 restarts" || fail "worker not running or has restarted"
for id in "$APP_ID" "$WORKER_ID"; do
  [ "$(state "$id" '{{.State.OOMKilled}}')" = false ] || fail "container $id was OOM-killed"
done

APP_LOG=$(mktemp); WORKER_LOG=$(mktemp); trap 'rm -f "$APP_LOG" "$WORKER_LOG"' EXIT
$COMPOSE logs --no-color app > "$APP_LOG" 2>&1
$COMPOSE logs --no-color worker > "$WORKER_LOG" 2>&1
check_logs "$APP_LOG" "$WORKER_LOG"

echo; [ "$FAILS" -eq 0 ] && echo "GO" || { echo "NO-GO ($FAILS failed)"; exit 1; }
