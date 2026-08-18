'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';

import { API_URL } from '@/lib/api';

interface Prompt {
  due: boolean;
  minutes: number;
  helpline: string;
}

/**
 * §2.12's session reality check: a prompt "after [60] min continuous use".
 *
 * Deliberately not a modal that traps you and not a toast that slides away
 * unread — a banner that stays until it is acknowledged, saying how long you
 * have been here and where the exits are. The server owns the clock, so the
 * prompt cannot be dodged by reloading the page.
 */
export function RealityCheck() {
  const [prompt, setPrompt] = useState<Prompt | null>(null);

  useEffect(() => {
    let cancelled = false;

    const check = (): void => {
      const token = window.localStorage.getItem('stakeam.token');
      if (token === null) return;

      void fetch(`${API_URL}/account/reality-check`, {
        headers: { authorization: `Bearer ${token}` },
      })
        .then(async (response) => (response.ok ? ((await response.json()) as Prompt) : null))
        .then((next) => {
          if (!cancelled && next?.due === true) setPrompt(next);
        })
        .catch(() => undefined);
    };

    check();
    const timer = setInterval(check, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <AnimatePresence>
      {prompt !== null && (
        <motion.aside
          initial={{ y: -20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -20, opacity: 0 }}
          role="status"
          className="sticky top-0 z-40 border-b border-border bg-surface-raised px-4 py-3"
        >
          <div className="mx-auto flex max-w-2xl items-start gap-3">
            <div className="flex-1">
              <p className="text-sm font-semibold">
                You have been playing for {prompt.minutes} minutes.
              </p>
              <p className="mt-1 text-sm text-text-muted">{prompt.helpline}</p>
              <a
                href="/account/limits"
                className="mt-1 inline-block text-sm text-rise underline underline-offset-2"
              >
                Set a limit or take a break
              </a>
            </div>
            <button
              type="button"
              onClick={() => setPrompt(null)}
              className="rounded-sm border border-border px-2 py-1 text-xs"
            >
              Got it
            </button>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
