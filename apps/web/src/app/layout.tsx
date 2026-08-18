import type { Metadata, Viewport } from 'next';
import { archivo, spaceMono } from '@/lib/fonts';
import { RealityCheck } from '@/components/reality-check';
import './globals.css';

export const metadata: Metadata = {
  title: 'StakeAm',
  description:
    "Nigeria's prediction market. Winners split the pot, creators earn from the markets they start, and every result settles against one official source.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FAFDF7' },
    { media: '(prefers-color-scheme: dark)', color: '#0B1A13' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${spaceMono.variable}`}>
      <body>
        {/* §2.12's session reality check sits above everything, on every screen. */}
        <RealityCheck />
        {children}
      </body>
    </html>
  );
}
