#!/usr/bin/env bash
#
# Take a backup (§2.13).
#
# `pg_dump -Fc` — the custom format, not plain SQL — because that is what
# `pg_restore` can restore selectively and in parallel. A plain-SQL dump of a
# database this shape restores as one long single-threaded transaction, which
# turns a recovery-time objective measured in minutes into one measured in
# however long it takes.
#
# The checksum beside each dump is not paranoia: a truncated backup and a
# complete one look identical in `ls`, and the moment you discover the
# difference is the moment you need the backup.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
DEST="${BACKUP_DIR:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${DEST}/stakeam-${STAMP}.dump"

mkdir -p "${DEST}"

echo "backing up to ${FILE}"
pg_dump --format=custom --no-owner --no-privileges --file="${FILE}" "${DATABASE_URL}"

sha256sum "${FILE}" > "${FILE}.sha256"

SIZE="$(du -h "${FILE}" | cut -f1)"
echo "wrote ${FILE} (${SIZE})"
echo "checksum: $(cut -d' ' -f1 < "${FILE}.sha256")"

# Retention is deliberately not "delete anything older than N days". A
# retention sweep that runs unattended is a way to lose the one backup you
# needed, so this only reports what is old and leaves the deletion to a person.
find "${DEST}" -name 'stakeam-*.dump' -mtime +30 -print \
  | sed 's/^/  stale (over 30 days): /' || true
