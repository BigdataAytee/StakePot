import { Module } from '@nestjs/common';

import { ChallengeService } from './challenge.service';
import { ReputationService } from './reputation.service';
import { ThreadService } from './thread.service';

/**
 * §2.15's community layer.
 *
 * Take threads, challenge links, the moderation between them, and §2.15b's
 * forecasting record. Depends on nothing but Prisma and config: the argument
 * is attached to markets, but it never moves money, so nothing here needs the
 * ledger and nothing here should be able to reach it.
 */
@Module({
  providers: [ThreadService, ChallengeService, ReputationService],
  exports: [ThreadService, ChallengeService, ReputationService],
})
export class CommunityLayerModule {}
