# Backups and restore drills

§2.13 asks for backups **and restore drills**. The second half is the one that
matters: a backup nobody has restored is a hypothesis, and every organisation
that has lost data had backups.

## Taking one

```bash
DATABASE_URL=… BACKUP_DIR=/var/backups/stakeam scripts/ops/backup.sh
```

Writes `stakeam-<UTC timestamp>.dump` in `pg_dump`'s custom format, plus a
`.sha256` beside it. Custom format rather than plain SQL because `pg_restore`
can parallelise it — a plain-SQL restore of this schema runs as one long
single-threaded transaction, which is the difference between a recovery time
in minutes and one in hours.

The script reports dumps older than 30 days and deletes nothing. A retention
sweep running unattended is a way to lose the one backup you needed.

## Proving one works

```bash
DATABASE_URL=… scripts/ops/restore-drill.sh /var/backups/stakeam/stakeam-….dump
```

The drill restores into a scratch database created for the purpose and dropped
afterwards, so running it against production credentials by mistake still
cannot overwrite production. It then checks the things whose absence would mean
the restore silently did nothing:

- row counts for `users`, `wallets`, `ledger`, `markets` — a restore that
  "succeeds" into an empty schema is the failure mode this exists to catch
- the ledger sum, because a restore that stopped mid-table leaves a book that
  does not balance, and that is better caught here than in the morning's
  reconciliation

Pass or fail, it writes a row to `restore_drills`, which the system room
(`/admin/system`) reads. That row is the answer to "when did we last prove a
backup works" — the only version of the question worth asking.

## Cadence

| What            | How often                                                     | Who              |
| --------------- | ------------------------------------------------------------- | ---------------- |
| Backup          | Nightly, automated                                            | Scheduled job    |
| Restore drill   | Monthly, and after any schema migration that rewrites a table | On-call engineer |
| Checksum verify | Every drill (automatic)                                       | —                |

The system room shows the last drill's age and turns it amber past 45 days.
That threshold is deliberately looser than the monthly cadence: an alarm that
fires the day after a target is missed gets muted, and a muted alarm is worse
than none.

## Recovery-time objective

The drill records `durationSec`. That figure is the RTO — not an estimate of
it, the measured value from the last real restore of a real backup. If it grows
past what the business can absorb, the fix is a change to the backup strategy
(more frequent base backups, WAL shipping), and the drill is what will tell you
before an incident does.

## What is _not_ covered here

- **Off-site replication.** The scripts write wherever `BACKUP_DIR` points.
  Getting those files onto storage in a different failure domain is deployment
  configuration, not repository code, and it is a real remaining gap.
- **Point-in-time recovery.** These are full dumps. PITR needs WAL archiving
  configured on the server, which is likewise a deployment concern.
