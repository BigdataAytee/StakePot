import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { CommunityModule } from '../community/community.module';
import { PlatformConfigModule } from '../platform-config/platform-config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LiquidityModule } from './liquidity.module';
import { SeedToolService } from './seed-tool.service';

/**
 * The seed half of the liquidity section.
 *
 * Its own module because it sits downstream of both the community module —
 * which owns the one place a symmetric top-up actually happens — and the
 * liquidity module, whose maker needs to be told that a market has been
 * seeded. Merging it into either one would put a cycle in the graph; see the
 * note in `liquidity.module.ts`.
 */
@Module({
  imports: [PrismaModule, PlatformConfigModule, AuditModule, CommunityModule, LiquidityModule],
  providers: [SeedToolService],
  exports: [SeedToolService],
})
export class SeedToolModule {}
