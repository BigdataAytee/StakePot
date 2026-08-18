import { Module } from '@nestjs/common';

import { ChallengeService } from './challenge.service';
import { ThreadService } from './thread.service';

/**
 * §2.15's community layer, phase 1 (§2.15f's launch slice).
 *
 * Take threads, challenge links, and the moderation between them. Depends on
 * nothing but Prisma and config: the argument is attached to markets, but it
 * never moves money, so nothing here needs the ledger and nothing here should
 * be able to reach it.
 */
@Module({
  providers: [ThreadService, ChallengeService],
  exports: [ThreadService, ChallengeService],
})
export class CommunityLayerModule {}
