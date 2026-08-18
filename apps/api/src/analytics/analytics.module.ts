import { Module } from '@nestjs/common';

import { AnalyticsService } from './analytics.service';

/**
 * §3's analytics table. Depends on nothing but Prisma, and is depended on by
 * everything — which is only safe because every write here is best-effort.
 */
@Module({
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
