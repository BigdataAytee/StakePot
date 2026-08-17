import { Archivo, Space_Mono } from 'next/font/google';

/**
 * Archivo carries the page — display and body both, 400–900, with 900 reserved
 * for headline numbers and market questions.
 */
export const archivo = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '900'],
  variable: '--font-archivo',
  display: 'swap',
});

/** Space Mono sets every live figure, with tabular numerals so ticks don't jitter. */
export const spaceMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-space-mono',
  display: 'swap',
});
