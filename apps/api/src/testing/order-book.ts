import type { FlagsService } from '../flags/flags.service';
import type { LedgerService } from '../ledger/ledger.service';
import { OrderBookService } from '../orderbook/orderbook.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { WalletService } from '../wallet/wallet.service';

/**
 * An order book for a test, with the flag off unless the test turns it on.
 *
 * Off is the important default. Every suite written before matching existed
 * asserts pot behaviour, and those assertions are exactly the regression test
 * for "the flag is a switch, not a rewrite" — with it off, a trade takes the
 * same path, moves the same money and writes the same rows as it always did.
 *
 * Pass the markets it should be on for to exercise matching.
 */
export function testOrderBook(
  prisma: PrismaService,
  ledger: LedgerService,
  wallet: WalletService,
  enabledForMarkets: readonly string[] = [],
): OrderBookService {
  const flags = {
    on: async (_key: string, subject: string | null): Promise<boolean> =>
      subject !== null && enabledForMarkets.includes(subject),
  } as unknown as FlagsService;

  return new OrderBookService(prisma, ledger, wallet, flags);
}
