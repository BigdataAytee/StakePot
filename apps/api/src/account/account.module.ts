import { Global, Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { WalletModule } from '../wallet/wallet.module';
import { ConsentService } from './consent.service';
import { FreezeService } from './freeze.service';
import { ReferralService } from './referral.service';
import { SessionsService } from './sessions.service';

/**
 * §2.18's account housekeeping, and §2.17's referrals.
 *
 * Global because a session check and a withdrawal freeze are consulted from
 * guards and from the wallet, and threading an import through both would make
 * them easy to forget in exactly the places that matter.
 */
@Global()
@Module({
  imports: [NotificationsModule, WalletModule],
  providers: [SessionsService, FreezeService, ConsentService, ReferralService],
  exports: [SessionsService, FreezeService, ConsentService, ReferralService],
})
export class AccountModule {}
