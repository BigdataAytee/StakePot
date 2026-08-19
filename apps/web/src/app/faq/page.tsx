import Link from 'next/link';

import { SiteFooter } from '@/components/site-footer';
import { PageShell } from '@/components/market/page-shell';

/**
 * The questions people actually ask before they stake.
 *
 * Not a marketing page. Every entry here is either something the walkthrough
 * showed somebody getting confused by, or something the product does that looks
 * like a bug until it is explained — the exit fee, the pot moving under you,
 * why the balance is points. The rules page says what the rules are; this says
 * what people get wrong about them.
 *
 * Marked up as a `FAQPage` in JSON-LD, which is what lets a search engine show
 * the answer rather than the page. The markup and the text below are generated
 * from the same array, so they cannot drift apart.
 */
export const metadata = {
  title: 'FAQ',
  description:
    'How StakeAm works, what a stake costs, why the price moves, and what happens when a market settles.',
};

const FAQS = [
  {
    q: 'Is this gambling?',
    a: "It is a prediction market. You are not betting against a house — there is no house on the other side of your trade and no edge built into the price. Everyone stakes into one pot, and when the event resolves the pot is split among whoever was right. StakeAm's income is a fee on the pot, stated on every market before you trade.",
  },
  {
    q: 'Is the money real?',
    a: 'Not yet. Balances are points while we are pre-licence: you cannot deposit and you cannot withdraw. Everything else — the prices, the pot, the settlement — works exactly as it will when money is real, which is the point of running it this way first.',
  },
  {
    q: 'What does it cost to join?',
    a: 'Nothing. You get a starter balance when you sign up, and more when you confirm your email or phone. No card, no deposit.',
  },
  {
    q: 'Why did the price move while I was staking?',
    a: 'Because somebody else staked. The price of an outcome is the share of the pot backing it, so every trade moves it — including yours. The trade sheet shows the price impact of your own stake before you commit to it.',
  },
  {
    q: 'Can I get out before the event happens?',
    a: 'Yes, any time while the market is open. You sell your shares back at the current price and an early-exit fee is withheld from the proceeds. The sheet itemises the gross, the fee and what actually lands in your wallet before you tap sell.',
  },
  {
    q: 'What happens when the event happens?',
    a: 'The market freezes at the time stated on the ticket, a result is entered against the source the market named when it opened, and after a dispute window it finalises. Winners are paid from the pot, and every payout writes a receipt you can check line by line in your wallet.',
  },
  {
    q: 'Who decides the result?',
    a: 'The source the market named before it opened — INEC, the CBN, CAF, the official broadcast — never our opinion. Two staff have to agree to finalise a resolution, and there is a dispute window before it pays out.',
  },
  {
    q: 'What is the difference between the Official and Community shelves?',
    a: 'Official markets are opened and settled by StakeAm against one named source. Community markets are opened by people who put up a bond and have to settle them honestly — they lose the bond if they do not. Both trade identically.',
  },
  {
    q: 'Can I open my own market?',
    a: 'Yes. The create wizard walks you through the question, the source that will settle it, and the edge cases, and every draft goes through review before it opens. A question that cannot be settled against a named source is refused, which is the whole job of that step.',
  },
  {
    q: 'How do I stop myself trading?',
    a: 'Set a stake limit, a cool-off, or a full self-exclusion in your account. They take effect immediately and we cannot talk you out of one — a cool-off cannot be shortened once it starts.',
  },
  {
    q: 'Something looks wrong with my balance.',
    a: 'Your wallet lists every entry that moved it, from the ledger, and the entries add up to the balance shown. If they do not, that is a bug we want to know about today — tell support and quote the entry that looks wrong.',
  },
] as const;

export default function FaqPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQS.map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };

  return (
    <PageShell width="narrow">
      {/* Same source as the visible list below, so the two cannot disagree. */}
      <script
        type="application/ld+json"
        // The content is built from the FAQS array above, not from anything a
        // user can reach, and JSON.stringify escapes it — there is no path from
        // input to this string.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <Link href="/" className="font-mono text-xs text-text-muted underline">
        ← StakeAm
      </Link>
      <h1 className="mt-4 text-2xl font-black leading-none">Questions</h1>
      <p className="mt-2 text-md text-text-muted">
        The things people ask before they stake. If yours is not here,{' '}
        <Link href="/support" className="font-bold underline">
          ask us
        </Link>
        .
      </p>

      <dl className="mt-8">
        {FAQS.map(({ q, a }) => (
          <div key={q} className="mb-6 border-b border-border pb-6 last:border-0">
            <dt className="text-lg font-bold">{q}</dt>
            <dd className="mt-2 text-md leading-relaxed text-text-muted">{a}</dd>
          </div>
        ))}
      </dl>

      <p className="text-md text-text-muted">
        The full rules are on{' '}
        <Link href="/rules" className="font-bold underline">
          the rules page
        </Link>
        , and what we do with your data is on{' '}
        <Link href="/privacy" className="font-bold underline">
          privacy
        </Link>
        .
      </p>

      <SiteFooter />
    </PageShell>
  );
}
