'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * §6.10's command palette.
 *
 * "Built for speed of operation, not decoration... an operator resolves a
 * market, clears a reconciliation exception, or approves a config change in
 * seconds."
 *
 * The console is fourteen screens deep now, and the fastest route between two
 * of them was the sidebar — which means moving a hand to a mouse and reading a
 * list. ⌘K is the fix, and it is the fix specifically because an operator
 * under pressure already knows where they are going; what slows them down is
 * the distance, not the decision.
 *
 * It also takes ids. Pasting a market id and pressing enter opens that market,
 * because the actual first move in most incidents is somebody handing you an
 * id in a chat message.
 */
interface Command {
  id: string;
  label: string;
  hint: string;
  href: string;
}

const COMMANDS: Command[] = [
  { id: 'dashboard', label: 'Dashboard', hint: 'reconciliation, escrow, queues', href: '/admin' },
  { id: 'approvals', label: 'Approvals inbox', hint: 'four-eyes queue', href: '/admin/approvals' },
  {
    id: 'resolution',
    label: 'Resolution centre',
    hint: 'results due, disputes',
    href: '/admin/resolution',
  },
  {
    id: 'money',
    label: 'Money room',
    hint: 'ledger, reserves, reconciliation',
    href: '/admin/money',
  },
  {
    id: 'lifecycle',
    label: 'Lifecycle',
    hint: 'funding windows, seed composition',
    href: '/admin/lifecycle',
  },
  {
    id: 'config',
    label: 'Platform config',
    hint: 'values, pending changes, history',
    href: '/admin/config',
  },
  {
    id: 'creators',
    label: 'Creators desk',
    hint: 'levels, bonds, templates',
    href: '/admin/creators',
  },
  {
    id: 'growth',
    label: 'Content & growth',
    hint: 'flags, broadcasts, Top Calls',
    href: '/admin/growth',
  },
  { id: 'system', label: 'System room', hint: 'queues, keys, backups', href: '/admin/system' },
  {
    id: 'drafts',
    label: 'Drafts queue',
    hint: 'AI and community proposals',
    href: '/admin/drafts',
  },
  {
    id: 'moderation',
    label: 'Moderation',
    hint: 'abuse and comment queues',
    href: '/admin/moderation',
  },
  { id: 'support', label: 'Support desk', hint: 'tickets and SLA timers', href: '/admin/support' },
  { id: 'prizes', label: 'Prizes', hint: 'weekly runs', href: '/admin/prizes' },
  { id: 'analytics', label: 'Analytics', hint: 'funnel and events', href: '/admin/analytics' },
];

/** A cuid, which is what an operator will have pasted. */
const ID = /^[a-z0-9]{20,32}$/i;

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((was) => !was);
        setQuery('');
        setCursor(0);
      }
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return COMMANDS;
    return COMMANDS.filter(
      (command) =>
        command.label.toLowerCase().includes(needle) || command.hint.toLowerCase().includes(needle),
    );
  }, [query]);

  const run = useCallback(
    (command: Command | undefined) => {
      const pasted = query.trim();
      // An id beats a name match: somebody who pasted an id wants that market,
      // not whichever screen happens to contain those letters.
      if (ID.test(pasted)) {
        router.push(`/market/${pasted}`);
        setOpen(false);
        return;
      }
      if (command === undefined) return;
      router.push(command.href);
      setOpen(false);
    },
    [query, router],
  );

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-md border border-border bg-surface shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={input}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setCursor((at) => Math.min(at + 1, matches.length - 1));
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setCursor((at) => Math.max(at - 1, 0));
            }
            if (event.key === 'Enter') run(matches[cursor]);
          }}
          placeholder="Go to… or paste a market id"
          aria-label="Command"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-md outline-none"
        />

        <ul className="max-h-80 overflow-y-auto">
          {ID.test(query.trim()) && (
            <li className="border-b border-border px-4 py-2.5 font-mono text-sm text-money">
              open market {query.trim()} ↵
            </li>
          )}
          {matches.map((command, index) => (
            <li key={command.id}>
              <button
                type="button"
                onMouseEnter={() => setCursor(index)}
                onClick={() => run(command)}
                className={`flex w-full items-baseline justify-between gap-4 px-4 py-2.5 text-left text-sm ${
                  index === cursor ? 'bg-surface-raised' : ''
                }`}
              >
                <span>{command.label}</span>
                <span className="font-mono text-xs text-text-muted">{command.hint}</span>
              </button>
            </li>
          ))}
          {matches.length === 0 && !ID.test(query.trim()) && (
            <li className="px-4 py-3 text-sm text-text-muted">Nothing matches that.</li>
          )}
        </ul>
      </div>
    </div>
  );
}
