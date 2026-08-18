import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';

import { archivo, spaceMono } from '@/lib/fonts';
import { RealityCheck } from '@/components/reality-check';
import './globals.css';

export const metadata: Metadata = {
  title: 'StakeAm',
  description:
    "Nigeria's prediction market. Winners split the pot, creators earn from the markets they start, and every result settles against one official source.",
  // §5.1 step 12's installable app. Nigerian mobile data is intermittent, and
  // the shell opening offline is the difference between "the app is down" and
  // "my connection dropped".
  manifest: '/manifest.json',
  appleWebApp: { capable: true, title: 'StakeAm', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FAFDF7' },
    { media: '(prefers-color-scheme: dark)', color: '#0B1A13' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Strings come from `messages/en-NG.json` rather than being inlined. There is
  // one locale today; the catalogue is the part that is hard to retrofit.
  const messages = await getMessages();

  return (
    <html lang="en-NG" className={`${archivo.variable} ${spaceMono.variable}`}>
      <body>
        <NextIntlClientProvider messages={messages}>
          {/* §2.12's session reality check sits above everything, on every screen. */}
          <RealityCheck />
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
