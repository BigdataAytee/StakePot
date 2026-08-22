import { Module } from '@nestjs/common';

import { CommunityModule } from '../community/community.module';
import { MarketFreezeModule } from './freeze.module';
import { MarketHealthModule } from './health.module';
import { MarketService } from './market.service';
import { OfficialMarketService } from './official-market.service';
import { StudioService } from './studio.service';
import { PriceWindowService } from './price-window.service';

/**
 * Official markets: the shelf the platform runs itself.
 *
 * Separate from `TradeModule` so the dependency runs one way — this module
 * needs the seed path that community markets already use, and nothing in the
 * community shelf needs to know official markets exist.
 */
@Module({
  imports: [CommunityModule, MarketFreezeModule, MarketHealthModule],
  providers: [MarketService, OfficialMarketService, PriceWindowService, StudioService],
  exports: [
    MarketFreezeModule,
    MarketHealthModule,
    OfficialMarketService,
    PriceWindowService,
    StudioService,
  ],
})
export class MarketModule {}
