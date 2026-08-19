'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * §6.10's work-queue auto-advance.
 *
 * "An operator resolves a market, clears a reconciliation exception, or
 * approves a config change in seconds, with zero ambiguity."
 *
 * The seconds go somewhere specific: after acting on item three, the list
 * re-renders and the operator has to find item four. This remembers where they
 * were and moves them on, so a queue of forty is forty decisions rather than
 * forty decisions plus forty searches.
 *
 * It advances on *resolution*, never on load. Auto-advancing when data arrives
 * would move somebody off the item they were reading because a poll finished,
 * which is the version of this feature that gets switched off in a week.
 */
export function useWorkQueue<T>(items: readonly T[], keyOf: (item: T) => string) {
  const [activeKey, setActiveKey] = useState<string | null>(null);

  // Land on the first item once, and never steal focus again on refresh.
  useEffect(() => {
    const first = items[0];
    if (activeKey === null && first !== undefined) setActiveKey(keyOf(first));
  }, [items, keyOf, activeKey]);

  /** Move to whatever now sits where the finished item was. */
  const advance = useCallback(() => {
    const index = items.findIndex((item) => keyOf(item) === activeKey);
    if (index === -1) {
      const first = items[0];
      setActiveKey(first === undefined ? null : keyOf(first));
      return;
    }
    const next = items[index + 1] ?? items[index - 1];
    setActiveKey(next === undefined ? null : keyOf(next));
  }, [items, keyOf, activeKey]);

  const isActive = useCallback((item: T) => keyOf(item) === activeKey, [keyOf, activeKey]);

  return { activeKey, setActiveKey, advance, isActive };
}

/**
 * §6.10's saved views.
 *
 * A filter an operator has to re-type every morning is a filter they stop
 * using. Stored per screen in local storage rather than on the server: these
 * are one person's habits on one machine, and syncing them would mean a
 * migration and a settings screen for something nobody would notice working.
 */
export function useSavedViews<T extends Record<string, unknown>>(screen: string, initial: T) {
  const storageKey = `stakeam.admin.views.${screen}`;
  const [views, setViews] = useState<Record<string, T>>({});
  const [current, setCurrent] = useState<T>(initial);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored !== null) setViews(JSON.parse(stored) as Record<string, T>);
    } catch {
      // A corrupt entry is not worth an error screen on an ops console.
    }
  }, [storageKey]);

  const save = useCallback(
    (name: string) => {
      const next = { ...views, [name]: current };
      setViews(next);
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    },
    [views, current, storageKey],
  );

  const remove = useCallback(
    (name: string) => {
      const next = { ...views };
      delete next[name];
      setViews(next);
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    },
    [views, storageKey],
  );

  return { views, current, setCurrent, save, remove, names: Object.keys(views).sort() };
}
