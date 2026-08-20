import { Module } from '@nestjs/common';

import { FlagsModule } from '../flags/flags.module';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletModule } from '../wallet/wallet.module';
import { OrderBookService } from './orderbook.service';

/**
 * Standalone, and imported by the trade module rather than the other way
 * round.
 *
 * The order book needs the wallet and the ledger; the trade path needs the
 * order book. Putting matching inside the trade module would have made that a
 * cycle the first time anything else wanted a depth reading.
 */
@Module({
  imports: [FlagsModule, LedgerModule, WalletModule],
  providers: [OrderBookService],
  exports: [OrderBookService],
})
export class OrderBookModule {}
