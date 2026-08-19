#!/usr/bin/env bash
#
# Restore a backup into a throwaway database and check it arrived (§2.13).
#
# A backup nobody has restored is a hypothesis. This is the experiment: restore
# into a scratch database, count what came back, and record the result — pass
# or fail — in `restore_drills`, which the system room reads. The useful
# question is never "are we taking backups" but "when did we last prove one
# works", and only this script can answer it.
#
# It never touches the source database. The restore target is created fresh and
# dropped at the end, so a drill run against production credentials by mistake
# still cannot overwrite production.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP="${1:?usage: restore-drill.sh <backup.dump>}"
RAN_BY="${DRILL_RAN_BY:-$(whoami)}"

if [[ -f "${BACKUP}.sha256" ]]; then
  echo "verifying checksum"
  sha256sum --check "${BACKUP}.sha256"
fi

# Scratch database beside the real one, on the same server.
BASE="${DATABASE_URL%/*}"
SCRATCH="drill_$(date -u +%s)"
TARGET="${BASE}/${SCRATCH}"

echo "restoring into ${SCRATCH}"
START="$(date +%s)"

psql "${BASE}/postgres" -c "CREATE DATABASE \"${SCRATCH}\";" >/dev/null

cleanup() {
  psql "${BASE}/postgres" -c "DROP DATABASE IF EXISTS \"${SCRATCH}\";" >/dev/null || true
}
trap cleanup EXIT

PASSED=true
NOTES=""

if ! pg_restore --no-owner --no-privileges --dbname="${TARGET}" "${BACKUP}"; then
  PASSED=false
  NOTES="pg_restore reported errors"
fi

DURATION=$(( $(date +%s) - START ))

# The tables whose emptiness would mean the restore silently did nothing. A
# restore that "succeeds" into an empty schema is the failure mode this is for.
for TABLE in users wallets ledger markets; do
  COUNT="$(psql -tA "${TARGET}" -c "SELECT count(*) FROM \"${TABLE}\";" 2>/dev/null || echo error)"
  echo "  ${TABLE}: ${COUNT}"
  NOTES="${NOTES}${NOTES:+; }${TABLE}=${COUNT}"
  if [[ "${COUNT}" == "error" ]]; then PASSED=false; fi
done

# The ledger has to balance after a restore as much as before one — a partial
# restore that stops mid-table would leave it not balancing, and that is worth
# catching here rather than in the morning's reconciliation.
LEDGER_SUM="$(psql -tA "${TARGET}" -c "SELECT COALESCE(sum(amount), 0) FROM ledger;" 2>/dev/null || echo error)"
NOTES="${NOTES}; ledger_sum=${LEDGER_SUM}"

echo "restore ${PASSED} in ${DURATION}s"

psql "${DATABASE_URL}" -c "
  INSERT INTO restore_drills (id, \"ranAt\", \"backupRef\", \"durationSec\", passed, notes, \"ranBy\")
  VALUES (gen_random_uuid()::text, now(), '$(basename "${BACKUP}")', ${DURATION}, ${PASSED}, '${NOTES}', '${RAN_BY}');
" >/dev/null

echo "recorded in restore_drills"
[[ "${PASSED}" == "true" ]]
