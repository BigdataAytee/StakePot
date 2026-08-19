'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/**
 * The hairline that runs across the top while a page is on its way.
 *
 * Every screen that matters here is rendered per request against live prices,
 * so a tap costs a round trip — and a tap that costs a round trip with nothing
 * on screen reads as a tap that did not register. People press it again. The
 * bar is the cheapest possible answer: it says "heard you" in the first 100ms
 * and gets out of the way.
 *
 * It creeps rather than reports. There is no progress to report — the server is
 * either still thinking or it is done — so the bar eases toward 90% on a curve
 * that never quite arrives, and only completes when the route actually changed.
 * A bar that claimed 40% would be making it up.
 *
 * Navigation is caught at the link rather than through a router event, because
 * the App Router does not expose one. Capture phase, so it still fires for
 * handlers that stop propagation.
 */
export function RouteProgress() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [running, setRunning] = useState(false);
  const [width, setWidth] = useState(0);
  const creep = useRef<ReturnType<typeof setInterval> | null>(null);
  // Mirrors `width` for the completion effect, which needs to know whether
  // there is a bar to finish without re-running every time the bar moves.
  const showing = useRef(false);

  useEffect(() => {
    showing.current = width > 0;
  }, [width]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      // Modified clicks open elsewhere; this tab is not going anywhere.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      const anchor = target instanceof Element ? target.closest('a') : null;
      if (anchor === null) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;

      const href = anchor.getAttribute('href');
      if (href === null || href.startsWith('#')) return;

      const next = new URL(anchor.href, window.location.href);
      if (next.origin !== window.location.origin) return;
      // Same place: nothing will change, so nothing should appear to.
      if (next.pathname === window.location.pathname && next.search === window.location.search) {
        return;
      }

      setRunning(true);
    }

    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // The route changed, so whatever was in flight has landed.
  useEffect(() => {
    setRunning(false);
  }, [pathname, search]);

  useEffect(() => {
    if (running) {
      setWidth(8);
      creep.current = setInterval(() => {
        // Decelerating: big steps early where the eye is, small ones later
        // where it would otherwise reach the end and sit there lying.
        setWidth((current) => (current >= 90 ? current : current + (90 - current) * 0.12));
      }, 120);

      return () => {
        if (creep.current !== null) clearInterval(creep.current);
        creep.current = null;
      };
    }

    if (creep.current !== null) {
      clearInterval(creep.current);
      creep.current = null;
    }
    // Complete, then fade — a bar that vanishes at 70% looks like a failure.
    if (!showing.current) return undefined;
    setWidth(100);
    const done = setTimeout(() => setWidth(0), 220);
    return () => clearTimeout(done);
  }, [running]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5"
      // Hidden rather than zero-width, so the completed bar fades out instead
      // of collapsing leftward.
      style={{ opacity: width === 0 ? 0 : 1, transition: 'opacity 200ms linear' }}
    >
      <div
        className="h-full bg-rise"
        style={{
          width: `${width}%`,
          transition: 'width 160ms ease-out',
          boxShadow: '0 0 8px currentColor',
        }}
      />
    </div>
  );
}
