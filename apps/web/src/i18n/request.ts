import { getRequestConfig } from 'next-intl/server';

/**
 * Localisation scaffolding (§5.1, step 12).
 *
 * Deliberately *without* locale routing. StakeAm ships in Nigerian English and
 * nothing else yet, and putting twelve routes behind `/[locale]/` for a single
 * locale would be churn that buys nothing today — while making every URL in the
 * app change on the day a second locale arrives, which is the wrong time to do
 * it. What this does buy now is the thing that is genuinely hard to retrofit:
 * strings living in a message catalogue instead of being inlined in JSX.
 *
 * Pidgin and Hausa/Yoruba/Igbo are the obvious next catalogues; adding routing
 * later is a config change plus a directory move, not a rewrite of every screen.
 */
export const LOCALE = 'en-NG';

export default getRequestConfig(async () => ({
  locale: LOCALE,
  messages: (await import(`../../messages/${LOCALE}.json`)).default,
}));
