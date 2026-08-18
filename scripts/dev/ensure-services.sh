#!/usr/bin/env bash
# Bring the local Postgres and Redis up if they are not already, and make sure
# the databases the test suites expect exist and are migrated.
#
# Written because a development container reclaims background processes: a suite
# that fails with "Can't reach database server" looks exactly like a broken
# change, and diagnosing that twice is once too many. Idempotent — safe to run
# before anything.
set -euo pipefail

DB_USER=${DB_USER:-stakeam}
DB_PASSWORD=${DB_PASSWORD:-stakeam}
MAIN_DB=${MAIN_DB:-stakeam}
TEST_DB=${TEST_DB:-stakeam_test}

if ! pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
  echo "postgres: starting"
  pg_ctlcluster 16 main start || true
  for _ in $(seq 1 30); do
    pg_isready -h localhost -p 5432 >/dev/null 2>&1 && break
    sleep 1
  done
fi
echo "postgres: up"

# The role and databases go missing with the cluster's data directory.
if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'\"" | grep -q 1; then
  echo "postgres: creating role ${DB_USER}"
  su postgres -c "psql -c \"CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}' SUPERUSER;\""
fi

for db in "$MAIN_DB" "$TEST_DB"; do
  if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${db}'\"" | grep -q 1; then
    echo "postgres: creating database ${db}"
    su postgres -c "psql -c 'CREATE DATABASE ${db} OWNER ${DB_USER};'"
  fi
done

if ! redis-cli ping >/dev/null 2>&1; then
  echo "redis: starting"
  redis-server --daemonize yes --save '' --appendonly no
  for _ in $(seq 1 20); do
    redis-cli ping >/dev/null 2>&1 && break
    sleep 1
  done
fi
echo "redis: up"

if [ "${MIGRATE:-1}" = "1" ]; then
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  for db in "$MAIN_DB" "$TEST_DB"; do
    DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${db}" \
      pnpm --dir "$root" --filter @stakeam/api exec prisma migrate deploy >/dev/null
    echo "migrated: ${db}"
  done
fi
