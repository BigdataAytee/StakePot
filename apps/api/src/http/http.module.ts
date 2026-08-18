import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthModule } from '../auth/auth.module';
import { JwtGuard } from '../auth/jwt.guard';
import { env } from '../config/env';
import { TradeModule } from '../trade/trade.module';
import { WalletModule } from '../wallet/wallet.module';
import { AuthController } from './auth.controller';
import { MarketsController } from './markets.controller';
import { TradesController } from './trades.controller';

@Module({
  imports: [
    AuthModule,
    TradeModule,
    WalletModule,
    JwtModule.register({
      secret: env.JWT_SECRET,
      signOptions: { expiresIn: env.JWT_EXPIRES_IN as `${number}m` },
    }),
  ],
  controllers: [AuthController, MarketsController, TradesController],
  providers: [JwtGuard],
})
export class HttpModule {}
