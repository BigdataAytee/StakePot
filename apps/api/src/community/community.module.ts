import { Module } from '@nestjs/common';

import { LedgerModule } from '../ledger/ledger.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ResolutionModule } from '../resolution/resolution.module';
import { SupportModule } from '../support/support.module';
import { WalletModule } from '../wallet/wallet.module';
import { CommunityService } from './community.service';
import { FundingWindowWorker } from './funding-window.worker';
import { CommunityQuestionModule } from './question-engine.module';
import { SeedService } from './seed.service';
import { MarketVoidService } from './void.service';

@Module({
  imports: [
    CommunityQuestionModule,
    LedgerModule,
    NotificationsModule,
    ResolutionModule,
    SupportModule,
    WalletModule,
  ],
  providers: [CommunityService, FundingWindowWorker, MarketVoidService, SeedService],
  exports: [
    CommunityQuestionModule,
    CommunityService,
    FundingWindowWorker,
    MarketVoidService,
    SeedService,
  ],
})
export class CommunityModule {}
