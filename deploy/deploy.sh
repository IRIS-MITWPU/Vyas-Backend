#!/usr/bin/env bash
# Deploy the checked-out commit on the EC2 host.
#   deploy/deploy.sh                 # TAG = git short SHA of the checkout (must be clean)
#   MIGRATE=1 deploy/deploy.sh       # run scripts/migrate.mjs against the DB before switching containers
#   TAG=v1.0.0 deploy/deploy.sh      # explicit tag (skips the git checks)
# Env files: /opt/vyas/app.env and /opt/vyas/redis.env (override with APP_ENV_FILE / REDIS_ENV_FILE).
# On a failed go/no-go check the new containers are left running for inspection: run deploy/rollback.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

STATE_DIR=${STATE_DIR:-/opt/vyas}

if [ -z "${TAG:-}" ]; then
  [ -z "$(git status --porcelain)" ] || { echo "Refusing to deploy a dirty checkout (commit or stash first)." >&2; exit 1; }
  TAG=$(git rev-parse --short HEAD)
fi
export TAG

# Remember what is running now, for rollback.sh.
prev=$(docker compose ps -q app 2>/dev/null | head -n1 | xargs -r docker inspect -f '{{.Config.Image}}' 2>/dev/null | sed 's/.*://' || true)
if [ -n "$prev" ] && [ "$prev" != "$TAG" ] && [ -d "$STATE_DIR" ]; then
  echo "$prev" > "$STATE_DIR/.last_tag"
fi

echo "==> Building vyas-backend:$TAG"
docker compose build

if [ "${MIGRATE:-}" = 1 ]; then
  echo "==> Running migrations"
  docker compose run --rm --no-deps app node scripts/migrate.mjs
fi

echo "==> Starting"
docker compose up -d

echo "==> Go/no-go checks"
if ! WAIT_SECS=${WAIT_SECS:-180} "$(dirname "$0")/check.sh"; then
  echo "Deploy of $TAG FAILED the go/no-go checks. Inspect: docker compose logs. Roll back: deploy/rollback.sh" >&2
  exit 1
fi

# Keep the newest 3 images (rmi refuses images that are in use).
docker images vyas-backend --format '{{.Tag}}' | tail -n +4 | while read -r t; do
  docker rmi "vyas-backend:$t" >/dev/null 2>&1 || true
done
echo "Deployed vyas-backend:$TAG (previous: ${prev:-none})"
