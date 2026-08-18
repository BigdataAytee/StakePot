import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AnalyticsModule } from '../analytics/analytics.module';
import { env } from '../config/env';
import { WalletModule } from '../wallet/wallet.module';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { TotpService } from './totp.service';

@Module({
  imports: [
    AnalyticsModule,
    WalletModule,
    JwtModule.register({
      secret: env.JWT_SECRET,
      // The env value is a zod-validated string ('15m'); jsonwebtoken's own
      // type for it is a narrower template literal than zod can express.
      signOptions: { expiresIn: env.JWT_EXPIRES_IN as `${number}m` },
    }),
  ],
  providers: [AuthService, OtpService, TotpService],
  exports: [AuthService, OtpService, TotpService],
})
export class AuthModule {}
