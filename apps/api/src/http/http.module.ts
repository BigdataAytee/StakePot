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
import { IntelModule } from '../intel/intel.module';
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
import {
  ConfigConsoleController,
  CreatorsDeskController,
  GrowthController,
  LifecycleController,
  SystemRoomController,
} from './admin-ops.controller';
import { AuthController } from './auth.controller';
import { PublicConfigController } from './public-config.controller';
import { StatusController } from './status.controller';
import { CommunityController } from './community.controller';
import { CreatorsController, MarketSignalsController } from './creators.controller';
import {
  AnalyticsController,
  LeaderboardController,
  PrizeController,
} from './leaderboard.controller';
import { MarketsController } from './markets.controller';
import { LiquidityModule } from '../liquidity/liquidity.module';
import { SeedToolModule } from '../liquidity/seed-tool.module';
import { LiquidityController } from './liquidity.controller';
import { StudioController } from './studio.controller';
import { ReputationController, TopCallsAdminController } from './reputation.controller';
import { ModerationController, ThreadsController } from './threads.controller';
import { TradesController } from './trades.controller';
import { OrderBookController } from './orderbook.controller';

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
    IntelModule,
    LeaderboardModule,
    LedgerModule,
    LiquidityModule,
    SeedToolModule,
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
    OrderBookController,
    AbuseController,
    AccountController,
    AdminController,
    ConfigConsoleController,
    CreatorsDeskController,
    DeviceController,
    GrowthController,
    LifecycleController,
    SystemRoomController,
    AuthController,
    PublicConfigController,
    StatusController,
    CommunityController,
    AnalyticsController,
    CreatorsController,
    LeaderboardController,
    PrizeController,
    MarketSignalsController,
    MarketsController,
    LiquidityController,
    StudioController,
    ModerationController,
    ReputationController,
    ThreadsController,
    TopCallsAdminController,
    TradesController,
  ],
  providers: [JwtGuard, OptionalJwtGuard, RolesGuard],
})
export class HttpModule {}
