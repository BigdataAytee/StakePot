import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CommunityModule } from '../community/community.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ApprovalsService } from './approvals.service';

@Module({
  imports: [AuthModule, LedgerModule, CommunityModule],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
