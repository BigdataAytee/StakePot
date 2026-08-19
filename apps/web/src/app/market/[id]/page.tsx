import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { TicketView } from '@/components/ticket-view';
import { api } from '@/lib/api';
import { SITE_URL } from '@/lib/site';

export const dynamic = 'force-dynamic';

/**
 * A market's own title, description and share card.
 *
 * This is the page that actually gets shared — a link into an argument, pasted
 * into a WhatsApp group. Without this it unfurled as "StakeAm" with the site's
 * generic blurb, which tells the group nothing and is the difference between a
 * link somebody taps and a link they scroll past.
 *
 * The card is the §2.14d share image the app already generates, so the picture
 * in the preview is the live prices rather than a logo. `alt` is not optional
 * on it: the preview is an image of a question and a number, and a reader who
 * cannot see it is owed the same sentence.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;

  try {
    const market = await api.market(id);
    const leader = [...market.outcomes].sort(
      (left, right) => Number(right.price) - Number(left.price),
    )[0];
    const standing =
      leader === undefined
        ? 'Live on StakeAm.'
        : `${leader.label} at ${Math.round(Number(leader.price) * 100)}%. Stake your side.`;
    const card = `${SITE_URL}/api/share/${id}`;

    return {
      title: market.question,
      description: standing,
      alternates: { canonical: `${SITE_URL}/market/${id}` },
      openGraph: {
        type: 'article',
        title: market.question,
        description: standing,
        url: `${SITE_URL}/market/${id}`,
        images: [
          {
            url: card,
            width: 1200,
            height: 630,
            alt: `${market.question} — ${standing}`,
          },
        ],
      },
      twitter: {
        card: 'summary_large_image',
        title: market.question,
        description: standing,
        images: [{ url: card, alt: `${market.question} — ${standing}` }],
      },
    };
  } catch {
    // A market that cannot be read still renders a 404 below; giving it a
    // truthful title beats letting the layout's default claim it is the home
    // page.
    return { title: 'Market not found' };
  }
}

/**
 * The ticket is server-rendered with its opening state, then goes live in the
 * browser. A shared link therefore unfurls with real prices rather than a
 * spinner — §7.3 asks for shared tickets to carry their chart.
 */
export default async function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const market = await api.market(id);
    // Binary renders one line; a multi-outcome market needs every candidate's
    // series in the first paint, or a shared link opens on a single line.
    const headline = market.outcomes[0];
    const only = market.outcomes.length === 2 ? headline?.id : undefined;
    const history = headline === undefined ? [] : await api.history(id, only, '1D');
    return <TicketView initial={market} initialHistory={history} />;
  } catch {
    notFound();
  }
}
