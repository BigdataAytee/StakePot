'use client';

import { useEffect, useState } from 'react';

import { admin, type SupportQueueTicket } from '@/lib/admin-api';

const SLA_TONE: Record<SupportQueueTicket['slaState'], string> = {
  ok: 'text-text-muted',
  due_soon: 'text-caution',
  breached: 'text-fall',
  paused: 'text-text-muted',
};

/**
 * The support desk (§6.7).
 *
 * "Ticket queues by category with SLA amber/red timers; ticket view shows the
 * user's **read-only** context (their market, their trade — never ledger
 * internals)."
 *
 * There is no balance anywhere on this screen, and there is no control that
 * changes one. That is the §6.11 role matrix made visible: support can see the
 * person and their market, and nothing else.
 */
export default function SupportDesk() {
  const [tickets, setTickets] = useState<SupportQueueTicket[]>([]);
  const [index, setIndex] = useState(0);
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (): void => {
    void admin
      .supportQueue()
      .then((rows) => {
        setTickets(rows);
        setIndex((current) => Math.min(current, Math.max(0, rows.length - 1)));
      })
      .catch((caught: Error) => setError(caught.message));
  };

  useEffect(load, []);

  const ticket = tickets[index];

  async function act(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      setReply('');
      load();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (ticket === undefined) {
    return (
      <div>
        <h1 className="text-lg font-black">Support desk</h1>
        <p className="mt-2 text-sm text-text-muted">
          {error ?? 'Queue clear. Nobody is waiting on us.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-black">Support desk</h1>
          <p className="mt-1 font-mono text-xs text-text-muted">
            item {index + 1} of {tickets.length} · {ticket.category} · {ticket.state}
          </p>
        </div>
        <div className="flex items-center gap-3 font-mono text-xs">
          <span className={SLA_TONE[ticket.slaState]}>
            {ticket.slaState === 'paused'
              ? 'waiting on them'
              : ticket.slaState === 'breached'
                ? `late since ${new Date(ticket.slaDue).toLocaleString('en-NG')}`
                : `due ${new Date(ticket.slaDue).toLocaleString('en-NG')}`}
          </span>
          <button
            type="button"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
            className="rounded-sm border border-border px-2 py-1 disabled:opacity-30"
          >
            prev
          </button>
          <button
            type="button"
            onClick={() => setIndex((i) => Math.min(tickets.length - 1, i + 1))}
            disabled={index >= tickets.length - 1}
            className="rounded-sm border border-border px-2 py-1 disabled:opacity-30"
          >
            next
          </button>
        </div>
      </header>

      <h2 className="text-md font-bold">{ticket.subject}</h2>

      <div className="grid grid-cols-3 gap-5">
        <section className="col-span-2 rounded-md border border-border p-4">
          <h3 className="text-sm font-semibold">Conversation</h3>
          <ol className="mt-3 space-y-3">
            {ticket.messages.map((message) => (
              <li
                key={message.id}
                className={`border-l pl-3 ${message.staffOnly ? 'border-money' : 'border-border'}`}
              >
                <p className="font-mono text-xs text-text-muted">
                  {new Date(message.createdAt).toLocaleString('en-NG')}
                  {message.staffOnly && <span className="ml-2 text-money">internal</span>}
                </p>
                <p className="text-sm">{message.body}</p>
              </li>
            ))}
          </ol>

          <div className="mt-4 space-y-2">
            <textarea
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              rows={3}
              placeholder="Reply to them, in plain words."
              className="w-full rounded-sm border border-border bg-surface px-2 py-1.5 text-sm"
            />
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={busy || reply.trim().length < 2}
                onClick={() =>
                  void act(() => admin.supportReply(ticket.id, reply.trim(), internal))
                }
                className="rounded-sm bg-rise px-3 py-1.5 text-sm font-bold text-paper disabled:opacity-40"
              >
                {internal ? 'Save note' : 'Send reply'}
              </button>
              <label className="flex items-center gap-1.5 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={internal}
                  onChange={(event) => setInternal(event.target.checked)}
                />
                internal note — they will not see it
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => admin.supportResolve(ticket.id))}
                className="ml-auto rounded-sm border border-border px-3 py-1.5 text-sm"
              >
                Mark resolved
              </button>
            </div>
          </div>
        </section>

        <section className="rounded-md border border-border p-4">
          <h3 className="text-sm font-semibold">Who is asking</h3>
          <dl className="mt-2 space-y-1.5 font-mono text-xs">
            <Row label="user" value={ticket.user.id.slice(0, 12) + '…'} />
            <Row label="email" value={ticket.user.email ?? '—'} />
            <Row label="phone" value={ticket.user.phone ?? '—'} />
            <Row label="tier" value={String(ticket.user.tier)} />
            <Row label="status" value={ticket.user.status} />
          </dl>

          {ticket.market !== null && (
            <>
              <h3 className="mt-4 text-sm font-semibold">Their market</h3>
              <p className="mt-1 text-sm">{ticket.market.question}</p>
              <p className="mt-1 font-mono text-xs text-text-muted">{ticket.market.state}</p>
            </>
          )}

          <p className="mt-4 text-xs text-text-muted">
            No balances here, by design — money questions go to the money room, and only Finance can
            open that.
          </p>
        </section>
      </div>

      {error !== null && <p className="text-sm text-fall">{error}</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-text-muted">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  );
}
