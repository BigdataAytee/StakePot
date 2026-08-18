import { Module } from '@nestjs/common';

import { AnalyticsModule } from '../analytics/analytics.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WalletModule } from '../wallet/wallet.module';
import { LeaderboardService } from './leaderboard.service';
import { PrizeService } from './prize.service';

/**
 * §2.8's engagement layer.
 *
 * The approvals module depends on *this* one, not the other way round: a prize
 * run is drawn up here and signed there, so the arrow points from the thing
 * that authorises money to the thing that computes it.
 */
@Module({
  imports: [AnalyticsModule, AuditModule, NotificationsModule, WalletModule],
  providers: [LeaderboardService, PrizeService],
  exports: [LeaderboardService, PrizeService],
})
export class LeaderboardModule {}
