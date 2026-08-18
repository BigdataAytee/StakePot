import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { CreatorAnalyticsService } from './analytics.service';
import { AutopsyService } from './autopsy.service';
import { CreatorService } from './creator.service';
import { NudgeService } from './nudge.service';
import { OpportunityService } from './opportunity.service';

/**
 * §2.14's creator platform.
 *
 * Deliberately depends on nothing but notifications, Prisma and config. The
 * community and resolution modules call *into* this one — the record moves when
 * a market settles, not the other way round — and keeping the arrow pointing
 * one way is what stops the dependency graph turning into a cycle the moment
 * anything else wants a creator's level.
 */
@Module({
  imports: [NotificationsModule],
  providers: [
    CreatorService,
    CreatorAnalyticsService,
    NudgeService,
    AutopsyService,
    OpportunityService,
  ],
  exports: [
    CreatorService,
    CreatorAnalyticsService,
    NudgeService,
    AutopsyService,
    OpportunityService,
  ],
})
export class CreatorModule {}
