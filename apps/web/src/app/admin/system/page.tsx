'use client';

import { useEffect, useState } from 'react';

import { ops, type SystemRoom } from '@/lib/admin-api';
import { dateTime } from '@/lib/format';

/**
 * §6.9's system room.
 *
 * "Queue/worker status, deploy & canary controls, alert history,
 * backup/restore drill logs, status-page incident posting."
 *
 * Read-mostly, deliberately. The one thing an engineering console must do
 * under pressure is tell you the truth quickly, and every control it grows is
 * another thing to get wrong at 3am. The two controls that matter — flags and
 * incidents — have their own screens, and this links to them.
 *
 * It refreshes on its own, because a system room left open showing a stale
 * "all clear" is worse than a blank one.
 */
export default function SystemRoomPage() {
  const [room, setRoom] = useState<SystemRoom | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void ops
        .system()
        .then((view) => {
          if (!cancelled) {
            setRoom(view);
            setError(null);
          }
        })
        .catch((caught: Error) => {
          if (!cancelled) setError(caught.message);
        });
    };
    load();
    const timer = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (error !== null) return <p className="text-sm text-fall">{error}</p>;
  if (room === null) return <p className="text-sm text-text-muted">Reading…</p>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-black">System room</h1>
        <p className="mt-1 text-sm text-text-muted">
          Queue depths, key hygiene, canaries and the last time a backup was proved to work.
        </p>
      </header>

      <section>
        <h2 className="text-sm font-semibold">Queues</h2>
        <p className="mt-1 text-sm text-text-muted">
          Rows sitting in a state something should have moved them out of. Overdue windows is the
          one that means a broken worker rather than a busy team.
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Depth label="approvals" value={room.queues.pendingApprovals} />
          <Depth label="disputes" value={room.queues.openDisputes} amberAbove={0} />
          <Depth label="drafts" value={room.queues.draftsWaiting} />
          <Depth label="results due" value={room.queues.resultsDue} amberAbove={0} />
          <Depth label="overdue windows" value={room.queues.overdueFundingWindows} redAbove={0} />
          <Depth label="unsent notices" value={room.queues.unsentNotifications} amberAbove={50} />
        </dl>
      </section>

      <section
        className={`rounded-md border p-4 ${
          room.backups.stale ? 'border-money/50 bg-money/5' : 'border-border'
        }`}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold">Backups</h2>
          <span className="font-mono text-xs">
            {room.backups.ageDays === null ? (
              <span className="text-fall">no drill has ever run</span>
            ) : (
              <span className={room.backups.stale ? 'text-money' : 'text-rise'}>
                last proved {room.backups.ageDays}d ago
              </span>
            )}
          </span>
        </div>

        <p className="mt-1 text-sm text-text-muted">
          A backup nobody has restored is a hypothesis. This is the last time one was actually
          restored and counted — run <code className="font-mono">scripts/ops/restore-drill.sh</code>
          .
        </p>

        {room.backups.lastDrill !== null && (
          <p className="mt-2 font-mono text-xs">
            {room.backups.lastDrill.passed ? (
              <span className="text-rise">passed</span>
            ) : (
              <span className="text-fall">FAILED</span>
            )}{' '}
            in {room.backups.lastDrill.durationSec}s · {room.backups.lastDrill.backupRef}
            <span className="block text-text-muted">{room.backups.lastDrill.notes}</span>
          </p>
        )}

        {room.backups.history.length > 1 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {room.backups.history.map((drill) => (
              <li
                key={drill.ranAt}
                title={`${dateTime(drill.ranAt)} · ${drill.durationSec}s`}
                className={`rounded-sm px-1.5 py-0.5 font-mono text-xs ${
                  drill.passed ? 'bg-rise/15 text-rise' : 'bg-fall/15 text-fall'
                }`}
              >
                {drill.durationSec}s
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold">Keys</h2>
        <p className="mt-1 text-sm text-text-muted">
          Ids and counts only — a console that can print a key is a console that leaks one. More
          than one accepted version means a rotation is in flight and the sweep is not finished.
        </p>
        <ul className="mt-3 divide-y divide-border rounded-md border border-border">
          {room.keys.map((key) => (
            <li key={key.name} className="flex items-baseline justify-between gap-3 p-2.5">
              <span className="font-mono text-sm">{key.name}</span>
              <span className="font-mono text-xs">
                {key.configured ? (
                  <>
                    <span className="text-text-muted">{key.currentKeyId}</span>
                    {key.acceptedVersions > 1 && (
                      <span className="ml-2 text-money">
                        rotating · {key.acceptedVersions} accepted
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-fall">not configured</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-semibold">Canaries</h2>
        {room.canary.length === 0 ? (
          <p className="mt-1 text-sm text-text-muted">
            No flags live. Nothing is being rolled out.
          </p>
        ) : (
          <ul className="mt-3 space-y-1">
            {room.canary.map((flag) => (
              <li
                key={flag.key}
                className="flex items-baseline justify-between gap-3 rounded-sm border border-border p-2.5 font-mono text-xs"
              >
                <span>{flag.key}</span>
                <span className={flag.rolloutPct < 100 ? 'text-money' : 'text-rise'}>
                  {flag.rolloutPct}%
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="text-sm font-semibold">Incidents</h2>
          <ul className="mt-3 space-y-1">
            {room.incidents.map((incident) => (
              <li key={incident.id} className="rounded-sm border border-border p-2.5 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span>{incident.title}</span>
                  <span
                    className={`font-mono text-xs ${
                      incident.state === 'resolved' ? 'text-text-muted' : 'text-fall'
                    }`}
                  >
                    {incident.state}
                  </span>
                </div>
                <p className="font-mono text-xs text-text-muted">
                  {incident.severity} · {dateTime(incident.startedAt)}
                </p>
              </li>
            ))}
            {room.incidents.length === 0 && (
              <li className="text-sm text-text-muted">Nothing recorded.</li>
            )}
          </ul>
        </div>

        <div>
          <h2 className="text-sm font-semibold">Recent staff actions</h2>
          <ul className="mt-3 space-y-0.5">
            {room.audit.map((entry, index) => (
              <li
                key={`${entry.at}:${index}`}
                className="flex items-baseline justify-between gap-3 font-mono text-xs"
              >
                <span className="truncate">
                  <span className="text-text-muted">{entry.staffId.slice(0, 8)}</span>{' '}
                  {entry.action}
                </span>
                <span className="shrink-0 text-text-muted">{dateTime(entry.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

function Depth({
  label,
  value,
  amberAbove,
  redAbove,
}: {
  label: string;
  value: number;
  amberAbove?: number;
  redAbove?: number;
}) {
  const red = redAbove !== undefined && value > redAbove;
  const amber = !red && amberAbove !== undefined && value > amberAbove;

  return (
    <div className="rounded-md border border-border p-3">
      <dt className="font-mono text-xs uppercase text-text-muted">{label}</dt>
      <dd
        className={`mt-1 font-mono text-xl font-bold tabular-nums ${
          red ? 'text-fall' : amber ? 'text-money' : ''
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
