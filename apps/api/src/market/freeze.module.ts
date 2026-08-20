import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { MarketFreezeService } from './freeze.service';

/**
 * The freeze, in a module of its own — for the same reason as
 * `MarketHealthModule`, and worth stating rather than inferring.
 *
 * The sweep that freezes markets is driven by the funding-window worker, which
 * lives in `CommunityModule`, and `MarketModule` already imports
 * `CommunityModule`. Putting the freeze service in `MarketModule` would close
 * that loop and Nest would refuse to start. A module that depends on nothing
 * but Prisma, audit, notifications and config can be imported by both.
 */
@Module({
  // Prisma, audit and platform config are @Global; notifications is not, and a
  // module that only listed the globals compiled, typechecked and passed every
  // test before dying on boot with "Nest can't resolve dependencies".
  imports: [NotificationsModule],
  providers: [MarketFreezeService],
  exports: [MarketFreezeService],
})
export class MarketFreezeModule {}
