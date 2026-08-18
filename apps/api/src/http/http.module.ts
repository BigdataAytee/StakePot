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
import { ResolutionModule } from '../resolution/resolution.module';
import { TradeModule } from '../trade/trade.module';
import { WalletModule } from '../wallet/wallet.module';
import { AdminController } from './admin.controller';
import { AuthController } from './auth.controller';
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
    ResolutionModule,
    TradeModule,
    WalletModule,
    JwtModule.register({
      secret: env.JWT_SECRET,
      signOptions: { expiresIn: env.JWT_EXPIRES_IN as `${number}m` },
    }),
  ],
  controllers: [
    AdminController,
    AuthController,
    CommunityController,
    MarketsController,
    TradesController,
  ],
  providers: [JwtGuard, RolesGuard],
})
export class HttpModule {}
