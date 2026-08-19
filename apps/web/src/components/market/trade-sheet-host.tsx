'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { TradeSheet } from '@/components/trade-sheet';
import { getToken } from '@/lib/session';
import { useTradeIntent } from '@/store/trade-intent';

/**
 * The one trade sheet on the page.
 *
 * Mounted once at the root of the grid rather than once per card: forty cards
 * would otherwise each carry a dialog, and only one can ever be open.
 */
export function TradeSheetHost() {
  const market = useTradeIntent((state) => state.market);
  const outcome = useTradeIntent((state) => state.outcome);
  const side = useTradeIntent((state) => state.side);
  const held = useTradeIntent((state) => state.held);
  const close = useTradeIntent((state) => state.close);
  const router = useRouter();

  // The token is read after mount: it lives in this browser, and reading it
  // during render would make the server's markup disagree with the client's.
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    setToken(getToken());
  }, [market]);

  if (market === null || outcome === null) return null;

  return (
    <TradeSheet
      market={market}
      intent={{ outcome, side, ...(held === undefined ? {} : { held }) }}
      livePrices={{}}
      token={token}
      onClose={close}
      onFilled={() => {
        // A fill moves the pot, the prices and the balance in the header at
        // once, so the shelf is re-read rather than patched in three places.
        close();
        router.refresh();
      }}
    />
  );
}
