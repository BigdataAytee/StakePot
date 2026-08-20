import { Module } from '@nestjs/common';

import { AnalyticsModule } from '../analytics/analytics.module';
import { CreatorModule } from '../creator/creator.module';
import { HardeningModule } from '../hardening/hardening.module';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { LedgerModule } from '../ledger/ledger.module';
import { IntelModule } from '../intel/intel.module';
import { MarketHealthModule } from '../market/health.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { ResolutionModule } from '../resolution/resolution.module';
import { SupportModule } from '../support/support.module';
import { WalletModule } from '../wallet/wallet.module';
import { CommunityService } from './community.service';
import { FundingWindowWorker } from './funding-window.worker';
import { CommunityQuestionModule } from './question-engine.module';
import { SeedService } from './seed.service';
import { TemplateLibraryService } from './template-library';
import { MarketVoidService } from './void.service';

@Module({
  imports: [
    AnalyticsModule,
    CommunityQuestionModule,
    CreatorModule,
    HardeningModule,
    LeaderboardModule,
    IntelModule,
    LedgerModule,
    MarketHealthModule,
    NotificationsModule,
    ReconciliationModule,
    ResolutionModule,
    SupportModule,
    WalletModule,
  ],
  providers: [
    CommunityService,
    FundingWindowWorker,
    MarketVoidService,
    SeedService,
    TemplateLibraryService,
  ],
  exports: [
    CommunityQuestionModule,
    CommunityService,
    FundingWindowWorker,
    MarketVoidService,
    SeedService,
    TemplateLibraryService,
  ],
})
export class CommunityModule {}
