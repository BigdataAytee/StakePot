import { notFound } from 'next/navigation';

import { TicketView } from '@/components/ticket-view';
import { api } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * The ticket is server-rendered with its opening state, then goes live in the
 * browser. A shared link therefore unfurls with real prices rather than a
 * spinner — §7.3 asks for shared tickets to carry their chart.
 */
export default async function MarketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const market = await api.market(id);
    const headline = market.outcomes[0];
    const history = headline === undefined ? [] : await api.history(id, headline.id, '1D');
    return <TicketView initial={market} initialHistory={history} />;
  } catch {
    notFound();
  }
}
