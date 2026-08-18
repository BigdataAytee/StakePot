import { Module } from '@nestjs/common';

import { CommunityModule } from '../community/community.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ApprovalsService } from './approvals.service';

@Module({
  imports: [LedgerModule, CommunityModule],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
