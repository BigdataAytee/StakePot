import { Module } from '@nestjs/common';

import { AdminModule } from './admin/admin.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { TokenRevocationModule } from './auth/token-revocation.service';
import { CommunityLayerModule } from './community-layer/community-layer.module';
import { CommunityModule } from './community/community.module';
import { CreatorModule } from './creator/creator.module';
import { HardeningModule } from './hardening/hardening.module';
import { HealthController } from './health/health.controller';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { LedgerModule } from './ledger/ledger.module';
import { MarketModule } from './market/market.module';
import { MetricsController } from './observability/metrics.controller';
import { PlatformConfigModule } from './platform-config/platform-config.module';
import { PrismaModule } from './prisma/prisma.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { RgModule } from './rg/rg.module';
import { StatusModule } from './status/status.module';
import { SupportModule } from './support/support.module';
import { ResolutionModule } from './resolution/resolution.module';
import { HttpModule } from './http/http.module';
import { RealtimeModule } from './realtime/realtime.module';
import { TradeModule } from './trade/trade.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    PrismaModule,
    PlatformConfigModule,
    AnalyticsModule,
    AuditModule,
    LedgerModule,
    WalletModule,
    AuthModule,
    TokenRevocationModule,
    ReconciliationModule,
    TradeModule,
    ResolutionModule,
    LeaderboardModule,
    ApprovalsModule,
    AdminModule,
    NotificationsModule,
    RgModule,
    SupportModule,
    StatusModule,
    CommunityModule,
    CommunityLayerModule,
    CreatorModule,
    HardeningModule,
    MarketModule,
    RealtimeModule,
    HttpModule,
  ],
  controllers: [HealthController, MetricsController],
})
export class AppModule {}
