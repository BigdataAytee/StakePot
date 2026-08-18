import { Module } from '@nestjs/common';

import { LedgerModule } from '../ledger/ledger.module';
import { ResolutionModule } from '../resolution/resolution.module';
import { WalletModule } from '../wallet/wallet.module';
import { CommunityService } from './community.service';
import { FundingWindowWorker } from './funding-window.worker';
import { QuestionEngineService } from './question-engine.service';
import { SeedService } from './seed.service';
import { MarketVoidService } from './void.service';

@Module({
  imports: [LedgerModule, ResolutionModule, WalletModule],
  providers: [
    CommunityService,
    FundingWindowWorker,
    MarketVoidService,
    QuestionEngineService,
    SeedService,
  ],
  exports: [
    CommunityService,
    FundingWindowWorker,
    MarketVoidService,
    QuestionEngineService,
    SeedService,
  ],
})
export class CommunityModule {}
