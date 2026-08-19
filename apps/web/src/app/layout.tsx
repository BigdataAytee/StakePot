import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';

import { Suspense } from 'react';

import { openSauce } from '@/lib/fonts';
import { SITE_URL } from '@/lib/site';
import { RealityCheck } from '@/components/reality-check';
import { RouteProgress } from '@/components/route-progress';
import './globals.css';

const DESCRIPTION =
  "Nigeria's prediction market. Winners split the pot, creators earn from the markets they start, and every result settles against one official source.";

export const metadata: Metadata = {
  // Absolute URLs are required for Open Graph and for the sitemap; without a
  // base, a shared link previews with a broken image and nobody can see why.
  metadataBase: new URL(SITE_URL),
  title: {
    // Every page names itself and the product: "Leaderboard · StakeAm". A tab
    // bar of nine tabs all reading "StakeAm" is a tab bar you cannot use, and
    // it is what a search result shows as its headline.
    default: 'StakeAm · Nigeria’s prediction market',
    template: '%s · StakeAm',
  },
  description: DESCRIPTION,
  // §5.1 step 12's installable app. Nigerian mobile data is intermittent, and
  // the shell opening offline is the difference between "the app is down" and
  // "my connection dropped".
  manifest: '/manifest.json',
  appleWebApp: { capable: true, title: 'StakeAm', statusBarStyle: 'default' },
  // What a link looks like when it is pasted into WhatsApp — which, for this
  // audience, is how most of them arrive. Individual markets override this with
  // their own question and card; this is the fallback for everything else.
  openGraph: {
    type: 'website',
    siteName: 'StakeAm',
    locale: 'en_NG',
    url: SITE_URL,
    title: 'StakeAm · Nigeria’s prediction market',
    description: DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: 'StakeAm · Nigeria’s prediction market',
    description: DESCRIPTION,
  },
  // Nothing here is behind a paywall or a login for a crawler to trip over.
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#ffffff' }],
};

/** The deployed commit, or an honest admission that nothing said. */
function buildCommit(): string {
  const commit = process.env['RENDER_GIT_COMMIT'] ?? process.env['GIT_COMMIT'] ?? '';
  return commit.length === 0 ? 'unknown' : commit.slice(0, 7);
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Strings come from `messages/en-NG.json` rather than being inlined. There is
  // one locale today; the catalogue is the part that is hard to retrofit.
  const messages = await getMessages();

  return (
    <html lang="en-NG" className={openSauce.variable}>
      <head>
        {/*
          The build this page came from, for anyone holding a phone rather than
          a terminal: view source and read one line. `/version` says the same
          thing to curl. Both exist because a change that did not appear could
          not be told from a deploy that did not happen.
        */}
        <meta name="build-commit" content={buildCommit()} />
      </head>
      <body>
        <NextIntlClientProvider messages={messages}>
          {/* Suspended because it reads the query string, which a statically
              rendered page has no answer for until it is asked for. */}
          <Suspense fallback={null}>
            <RouteProgress />
          </Suspense>
          {/* §2.12's session reality check sits above everything, on every screen. */}
          <RealityCheck />
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
