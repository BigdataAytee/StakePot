import { API_URL } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface StatusView {
  status: 'operational' | 'informational' | 'degraded' | 'outage';
  checkedAt: string;
  reconciliation: { status: string; runDate: string | null };
  incidents: {
    id: string;
    title: string;
    severity: string;
    state: string;
    startedAt: string;
    resolvedAt: string | null;
    updates: { id: string; state: string; body: string; createdAt: string }[];
  }[];
}

const HEADLINE: Record<StatusView['status'], { text: string; tone: string }> = {
  operational: { text: 'Everything is working', tone: 'text-rise' },
  informational: { text: 'Working, with a notice', tone: 'text-text' },
  degraded: { text: 'Some things are slow', tone: 'text-money' },
  outage: { text: 'Something is down', tone: 'text-fall' },
};

/**
 * The public status page (§2.12): "incidents posted with timestamps —
 * transparency as a feature."
 *
 * Server-rendered and unauthenticated on purpose. A status page you need to log
 * in to read is useless on exactly the day it matters, and the money check is
 * published alongside the uptime because §2.10's reconciliation is the number
 * people actually want when they are worried.
 */
export default async function StatusPage() {
  let view: StatusView | null = null;
  try {
    const response = await fetch(`${API_URL}/status`, { cache: 'no-store' });
    if (response.ok) view = (await response.json()) as StatusView;
  } catch {
    view = null;
  }

  if (view === null) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-xl font-black">Status</h1>
        <p className="mt-3 text-md text-fall">
          We could not reach the status service. That is itself a problem, and we are on it.
        </p>
      </main>
    );
  }

  const headline = HEADLINE[view.status];
  const live = view.incidents.filter((incident) => incident.state !== 'resolved');
  const past = view.incidents.filter((incident) => incident.state === 'resolved');

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-xl font-black">StakeAm status</h1>
      <p className={`mt-3 text-2xl font-black ${headline.tone}`}>{headline.text}</p>
      <p className="mt-1 font-mono text-sm text-text-muted">
        checked {new Date(view.checkedAt).toLocaleString('en-NG')}
      </p>

      <section className="mt-6 rounded-md border border-border p-4">
        <h2 className="text-sm font-semibold">Daily money check</h2>
        <p className="mt-1 text-sm text-text-muted">
          Every day we recompute every balance from the ledger and compare it to what the wallets
          say. This is that result.
        </p>
        <p
          className={`mt-2 font-mono text-md uppercase ${
            view.reconciliation.status === 'clean' ? 'text-rise' : 'text-fall'
          }`}
        >
          {view.reconciliation.status}
          {view.reconciliation.runDate !== null && (
            <span className="ml-2 text-sm normal-case text-text-muted">
              {new Date(view.reconciliation.runDate).toLocaleDateString('en-NG')}
            </span>
          )}
        </p>
      </section>

      {live.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold">Happening now</h2>
          <div className="mt-3 space-y-4">
            {live.map((incident) => (
              <Incident key={incident.id} incident={incident} />
            ))}
          </div>
        </section>
      )}

      <section className="mt-6">
        <h2 className="text-sm font-semibold">Past 30 days</h2>
        {past.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">No incidents.</p>
        ) : (
          <div className="mt-3 space-y-4">
            {past.map((incident) => (
              <Incident key={incident.id} incident={incident} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function Incident({ incident }: { incident: StatusView['incidents'][number] }) {
  return (
    <article className="rounded-md border border-border p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-semibold">{incident.title}</h3>
        <span className="font-mono text-xs uppercase text-text-muted">{incident.state}</span>
      </div>
      <p className="mt-1 font-mono text-xs text-text-muted">
        started {new Date(incident.startedAt).toLocaleString('en-NG')}
        {incident.resolvedAt !== null &&
          ` · resolved ${new Date(incident.resolvedAt).toLocaleString('en-NG')}`}
      </p>
      <ol className="mt-3 space-y-2">
        {incident.updates.map((update) => (
          <li key={update.id} className="border-l border-border pl-3">
            <p className="font-mono text-xs text-text-muted">
              {new Date(update.createdAt).toLocaleString('en-NG')} · {update.state}
            </p>
            <p className="text-sm">{update.body}</p>
          </li>
        ))}
      </ol>
    </article>
  );
}
