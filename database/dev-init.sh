#!/bin/sh
# Dev-only DB bootstrap, run once by the postgres image on an empty volume
# (docker-compose.dev.yml). Same result as `npm run db:migrate` on an empty DB
# (schema.sql, then every migration, recorded in schema_migrations) — kept in
# sh because the postgres image has no node. Real databases use the runner.
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f /vyas-db/schema.sql
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"
for f in /vyas-db/migrations/*.sql; do
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -1 -f "$f" \
    -c "INSERT INTO schema_migrations (filename) VALUES ('$(basename "$f")')"
done
