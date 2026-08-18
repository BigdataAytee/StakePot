import { Module } from '@nestjs/common';

import { LedgerModule } from '../ledger/ledger.module';
import { WalletModule } from '../wallet/wallet.module';
import { CommunityService } from './community.service';
import { FundingWindowWorker } from './funding-window.worker';
import { QuestionEngineService } from './question-engine.service';

@Module({
  imports: [LedgerModule, WalletModule],
  providers: [CommunityService, FundingWindowWorker, QuestionEngineService],
  exports: [CommunityService, FundingWindowWorker, QuestionEngineService],
})
export class CommunityModule {}
