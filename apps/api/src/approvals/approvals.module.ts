import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CommunityModule } from '../community/community.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ApprovalsService } from './approvals.service';

@Module({
  imports: [AuthModule, CommunityModule, LeaderboardModule, LedgerModule],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
