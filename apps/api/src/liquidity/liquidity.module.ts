import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { FlagsModule } from '../flags/flags.module';
import { LedgerModule } from '../ledger/ledger.module';
import { OrderBookModule } from '../orderbook/orderbook.module';
import { PlatformConfigModule } from '../platform-config/platform-config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StubFundingConnector } from './funding.connector';
import { MarketMakerService } from './market-maker.service';
import { LiquidityModeService } from './mode.service';

/**
 * The market maker and the mode guard above it.
 *
 * The *seed* half of the liquidity section lives in `SeedToolModule` next
 * door, and the split is not tidiness — it is what keeps the dependency graph
 * a graph. The seed tool needs `SeedService` from the community module; the
 * community module's worker needs the maker's sweep. Left in one module those
 * two facts are a cycle, and the usual answer, `forwardRef`, buys you a
 * runtime resolution order that nothing checks and that fails at boot rather
 * than at build.
 *
 * So: this module depends on nothing that depends on it. Quoting goes through
 * `OrderBookService`, which goes through the same escrow the rest of the book
 * uses. Everything here is policy on top — budgets, ceilings, and switches.
 */
@Module({
  imports: [
    PrismaModule,
    PlatformConfigModule,
    FlagsModule,
    LedgerModule,
    AuditModule,
    OrderBookModule,
  ],
  providers: [LiquidityModeService, MarketMakerService, StubFundingConnector],
  exports: [LiquidityModeService, MarketMakerService, StubFundingConnector],
})
export class LiquidityModule {}
