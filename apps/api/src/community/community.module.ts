import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletModule } from '../wallet/wallet.module';
import { CommunityService } from './community.service';
import { FundingWindowWorker } from './funding-window.worker';
import { QuestionEngineService } from './question-engine.service';
import { SeedService } from './seed.service';
import { MarketVoidService } from './void.service';

@Module({
  imports: [AuditModule, LedgerModule, WalletModule],
  providers: [
    CommunityService,
    FundingWindowWorker,
    MarketVoidService,
    QuestionEngineService,
    SeedService,
  ],
  exports: [CommunityService, FundingWindowWorker, QuestionEngineService, SeedService],
})
export class CommunityModule {}
