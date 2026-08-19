'use client';

import { useEffect, useRef, useState } from 'react';

import { useWorkQueue } from '@/components/admin/work-queue';
import { admin, type PendingApproval } from '@/lib/admin-api';

/** Stable identity for the work queue. */
const keyOf = (item: PendingApproval): string => item.id;

/**
 * §6.4's approvals inbox.
 *
 * "Every four-eyes item shows *what changes, old → new, who proposed, their
 * written reason* in a diff-style card." The approve button is the only place in
 * the cockpit where money moves, and it moves because a second person pressed
 * it — the API refuses the proposer's own click, so this screen never has to.
 */
export default function ApprovalsInbox() {
  const [items, setItems] = useState<PendingApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [codes, setCodes] = useState<Record<string, string>>({});

  // §6.10's work-queue auto-advance. An approvals inbox is the console's
  // highest-volume queue, and without this the operator loses their place on
  // every decision — forty approvals become forty decisions plus forty
  // searches for where they had got to.
  const { advance, isActive, setActiveKey } = useWorkQueue(items, keyOf);
  const rows = useRef<Record<string, HTMLLIElement | null>>({});

  const load = (): void => {
    void admin
      .approvals()
      .then(setItems)
      .catch((caught: Error) => setError(caught.message));
  };

  useEffect(load, []);

  async function act(id: string, action: () => Promise<unknown>): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      await action();
      // Advance before reloading: the finished item is about to leave the
      // list, and picking the next one from the list that still contains it is
      // the only moment "next" is unambiguous.
      advance();
      load();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // Bring the active row into view when it moves on its own. Only then — a
  // scroll that fires on every refresh would fight whoever is reading.
  const active = items.find(isActive);
  const activeId = active?.id ?? null;
  useEffect(() => {
    if (activeId === null) return;
    rows.current[activeId]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeId]);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-black">Approvals</h1>
        <p className="mt-1 text-sm text-text-muted">
          Nothing here executes until a second person approves it. The proposer cannot be that
          person.
        </p>
      </header>

      {error !== null && <p className="text-sm text-fall">{error}</p>}

      {items.length === 0 ? (
        <p className="text-sm text-text-muted">Inbox clear.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li
              key={item.id}
              ref={(node) => {
                rows.current[item.id] = node;
              }}
              onFocusCapture={() => setActiveKey(item.id)}
              className={`rounded-md border p-4 transition-colors ${
                isActive(item) ? 'border-brand bg-surface-raised/40' : 'border-border'
              }`}
            >
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-semibold">{item.summary}</h2>
                <span className="font-mono text-xs text-text-muted">{item.actionType}</span>
              </div>

              {/* The diff: exactly what would change, old → new (§6.4b). */}
              {item.current === null ? (
                <pre className="mt-2 overflow-x-auto rounded-sm border border-border bg-surface-raised px-3 py-2 font-mono text-xs">
                  {JSON.stringify(item.payload, null, 2)}
                </pre>
              ) : (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <pre className="overflow-x-auto rounded-sm border border-border bg-surface-raised px-3 py-2 font-mono text-xs text-text-muted">
                    <span className="block text-xs uppercase tracking-wide">now</span>
                    {JSON.stringify(item.current, null, 2)}
                  </pre>
                  <pre className="overflow-x-auto rounded-sm border border-rise bg-rise/10 px-3 py-2 font-mono text-xs">
                    <span className="block text-xs uppercase tracking-wide text-text-muted">
                      proposed
                    </span>
                    {JSON.stringify(item.payload, null, 2)}
                  </pre>
                </div>
              )}

              <p className="mt-2 text-sm">
                <span className="text-text-muted">Reason: </span>
                {item.reason}
              </p>
              <p className="mt-1 font-mono text-xs text-text-muted">
                proposed by {item.requestedBy.slice(0, 8)}… on{' '}
                {new Date(item.createdAt).toLocaleString('en-NG')}
              </p>

              <div className="mt-3 flex items-center gap-2">
                {/* §6.4b: the approve button triggers the step-up 2FA inline. */}
                <input
                  value={codes[item.id] ?? ''}
                  onChange={(event) =>
                    setCodes((current) => ({ ...current, [item.id]: event.target.value }))
                  }
                  inputMode="numeric"
                  placeholder="2FA code"
                  aria-label={`Authenticator code to approve ${item.actionType}`}
                  className="w-28 rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-sm tabular-nums"
                />
                <button
                  type="button"
                  disabled={busy === item.id || (codes[item.id] ?? '').trim().length < 6}
                  onClick={() =>
                    void act(item.id, () => admin.approve(item.id, (codes[item.id] ?? '').trim()))
                  }
                  className="rounded-sm bg-rise px-3 py-1.5 text-sm font-bold text-paper disabled:opacity-40"
                >
                  Approve &amp; execute
                </button>
                <input
                  value={notes[item.id] ?? ''}
                  onChange={(event) =>
                    setNotes((current) => ({ ...current, [item.id]: event.target.value }))
                  }
                  placeholder="Why not? The proposer sees this."
                  aria-label={`Reason for rejecting ${item.actionType}`}
                  className="flex-1 rounded-sm border border-border bg-surface px-2 py-1.5 text-sm"
                />
                <button
                  type="button"
                  disabled={busy === item.id || (notes[item.id] ?? '').trim().length < 10}
                  onClick={() =>
                    void act(item.id, () => admin.reject(item.id, (notes[item.id] ?? '').trim()))
                  }
                  className="rounded-sm border border-border px-3 py-1.5 text-sm disabled:opacity-30"
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
