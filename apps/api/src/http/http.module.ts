import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AdminModule } from '../admin/admin.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuthModule } from '../auth/auth.module';
import { CommunityModule } from '../community/community.module';
import { JwtGuard } from '../auth/jwt.guard';
import { RolesGuard } from '../auth/roles.guard';
import { env } from '../config/env';
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
import { AdminController } from './admin.controller';
import { AuthController } from './auth.controller';
import { StatusController } from './status.controller';
import { CommunityController } from './community.controller';
import { MarketsController } from './markets.controller';
import { TradesController } from './trades.controller';

@Module({
  imports: [
    AdminModule,
    ApprovalsModule,
    AuthModule,
    CommunityModule,
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
    AccountController,
    AdminController,
    AuthController,
    StatusController,
    CommunityController,
    MarketsController,
    TradesController,
  ],
  providers: [JwtGuard, RolesGuard],
})
export class HttpModule {}
