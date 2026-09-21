#!/usr/bin/env bash
# Redeploy a previous image (already on the host: deploy.sh keeps the last 3).
#   deploy/rollback.sh              # the tag recorded before the last deploy (/opt/vyas/.last_tag)
#   deploy/rollback.sh a1b2c3d      # a specific tag
# Rolls back code only. If the failed deploy ran migrations (MIGRATE=1), schema changes stay:
# migrations 010-012 are additive/idempotent, but check REMEDIATION-LOG.md before rolling back past them.
set -euo pipefail
cd "$(dirname "$0")/.."

STATE_DIR=${STATE_DIR:-/opt/vyas}
TAG=${1:-$(cat "$STATE_DIR/.last_tag" 2>/dev/null || true)}
[ -n "$TAG" ] || { echo "No tag given and $STATE_DIR/.last_tag is missing." >&2; exit 1; }
docker image inspect "vyas-backend:$TAG" >/dev/null 2>&1 || { echo "Image vyas-backend:$TAG is not on this host." >&2; exit 1; }
export TAG

echo "==> Rolling back to vyas-backend:$TAG"
docker compose up -d --no-build
WAIT_SECS=${WAIT_SECS:-180} "$(dirname "$0")/check.sh"
echo "Rolled back to vyas-backend:$TAG"
