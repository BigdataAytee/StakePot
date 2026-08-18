import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AdminModule } from '../admin/admin.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { CommunityLayerModule } from '../community-layer/community-layer.module';
import { HardeningModule } from '../hardening/hardening.module';
import { CommunityModule } from '../community/community.module';
import { CreatorModule } from '../creator/creator.module';
import { JwtGuard, OptionalJwtGuard } from '../auth/jwt.guard';
import { RolesGuard } from '../auth/roles.guard';
import { env } from '../config/env';
import { LeaderboardModule } from '../leaderboard/leaderboard.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MarketModule } from '../market/market.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RgModule } from '../rg/rg.module';
import { StatusModule } from '../status/status.module';
import { SupportModule } from '../support/support.module';
import { ResolutionModule } from '../resolution/resolution.module';
import { TradeModule } from '../trade/trade.module';
import { WalletModule } from '../wallet/wallet.module';
import { AccountController } from './account.controller';
import { AbuseController, DeviceController } from './abuse.controller';
import { AdminController } from './admin.controller';
import { AuthController } from './auth.controller';
import { StatusController } from './status.controller';
import { CommunityController } from './community.controller';
import { CreatorsController, MarketSignalsController } from './creators.controller';
import {
  AnalyticsController,
  LeaderboardController,
  PrizeController,
} from './leaderboard.controller';
import { MarketsController } from './markets.controller';
import { ModerationController, ThreadsController } from './threads.controller';
import { TradesController } from './trades.controller';

@Module({
  imports: [
    AdminModule,
    AnalyticsModule,
    ApprovalsModule,
    AuthModule,
    CommunityLayerModule,
    CommunityModule,
    CreatorModule,
    HardeningModule,
    LeaderboardModule,
    LedgerModule,
    MarketModule,
    NotificationsModule,
    ResolutionModule,
    RgModule,
    StatusModule,
    SupportModule,
    TradeModule,
    WalletModule,
    JwtModule.register({
      secret: env.JWT_SECRET,
      signOptions: { expiresIn: env.JWT_EXPIRES_IN as `${number}m` },
    }),
  ],
  controllers: [
    AbuseController,
    AccountController,
    AdminController,
    DeviceController,
    AuthController,
    StatusController,
    CommunityController,
    AnalyticsController,
    CreatorsController,
    LeaderboardController,
    PrizeController,
    MarketSignalsController,
    MarketsController,
    ModerationController,
    ThreadsController,
    TradesController,
  ],
  providers: [JwtGuard, OptionalJwtGuard, RolesGuard],
})
export class HttpModule {}
