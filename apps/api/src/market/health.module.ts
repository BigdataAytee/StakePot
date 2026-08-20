import { Module } from '@nestjs/common';

import { MarketHealthService } from './health.service';

/**
 * Part 5 monitoring, in a module of its own.
 *
 * Small enough to look like it belongs inside `MarketModule`, and it cannot:
 * the sweep is driven by the funding-window worker in `CommunityModule`, and
 * `MarketModule` already imports `CommunityModule`. A module that depends on
 * nothing but Prisma can be imported by both without the cycle.
 */
@Module({
  providers: [MarketHealthService],
  exports: [MarketHealthService],
})
export class MarketHealthModule {}
