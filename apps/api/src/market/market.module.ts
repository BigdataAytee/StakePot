import { Module } from '@nestjs/common';

import { CommunityModule } from '../community/community.module';
import { MarketService } from './market.service';
import { OfficialMarketService } from './official-market.service';

/**
 * Official markets: the shelf the platform runs itself.
 *
 * Separate from `TradeModule` so the dependency runs one way — this module
 * needs the seed path that community markets already use, and nothing in the
 * community shelf needs to know official markets exist.
 */
@Module({
  imports: [CommunityModule],
  providers: [MarketService, OfficialMarketService],
  exports: [OfficialMarketService],
})
export class MarketModule {}
