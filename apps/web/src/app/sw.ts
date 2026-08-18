import { defaultCache } from '@serwist/next/worker';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { Serwist } from 'serwist';

/**
 * The PWA service worker (§5.1, step 12: "installable app, offline shell").
 *
 * Nigerian mobile data is intermittent, and a prediction market is exactly the
 * kind of app somebody opens on a viewing-centre wifi that drops mid-match. The
 * shell is precached so the app opens rather than showing a browser error page.
 *
 * What is deliberately *not* precached is anything with a number on it. Prices,
 * pots and positions go through `defaultCache`'s network-first strategies; a
 * stale price shown as current is worse than no price at all, because somebody
 * will trade on it.
 */
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

// The worker runs in a service-worker global, which this project's DOM lib does
// not describe. Typed structurally rather than by pulling `WebWorker` into the
// whole app's lib list, which would let DOM-only code compile against APIs the
// browser thread does not have.
declare const self: {
  __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
};

// Bound exactly once: the build scans this file for `self.__SW_MANIFEST` and
// refuses to inject if it appears more than once.
const manifest = self.__SW_MANIFEST;

const serwist = new Serwist({
  // `exactOptionalPropertyTypes` is on across the repo, and the manifest is
  // genuinely absent until the build writes it — so the key is omitted rather
  // than set to undefined.
  ...(manifest === undefined ? {} : { precacheEntries: manifest }),
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: defaultCache,
});

serwist.addEventListeners();
