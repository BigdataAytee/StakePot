import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { env } from '../config/env';
import { WalletModule } from '../wallet/wallet.module';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';

@Module({
  imports: [
    WalletModule,
    JwtModule.register({
      secret: env.JWT_SECRET,
      // The env value is a zod-validated string ('15m'); jsonwebtoken's own
      // type for it is a narrower template literal than zod can express.
      signOptions: { expiresIn: env.JWT_EXPIRES_IN as `${number}m` },
    }),
  ],
  providers: [AuthService, OtpService],
  exports: [AuthService, OtpService],
})
export class AuthModule {}
