import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AnthropicAnalyst } from './anthropic-analyst';
import { DossierService } from './dossier.service';
import { DisabledFetcher, SOURCE_FETCHER } from './fetcher';
import { RESOLUTION_ANALYST } from './resolution-analyst';
import { ResearchService } from './research.service';
import { SourceRegistryService } from './source-registry.service';

/**
 * The market intelligence layer.
 *
 * Two of the three providers are deliberately absent by default. The fetcher
 * is bound to `DisabledFetcher`, so a deployment reads nothing until an
 * operator says otherwise; the analyst resolves to null when no API key is
 * configured, so a dossier says "no analysis was run" rather than looking like
 * a clean one. Both defaults are the safe direction: a pipeline that starts
 * crawling on boot crawls from CI and from every preview environment, and a
 * blank dossier that looks confident is what gets a market settled off an
 * empty screen.
 */
@Module({
  imports: [PrismaModule, AuditModule],
  providers: [
    SourceRegistryService,
    ResearchService,
    DossierService,
    { provide: SOURCE_FETCHER, useClass: DisabledFetcher },
    { provide: RESOLUTION_ANALYST, useFactory: () => AnthropicAnalyst.create() },
  ],
  exports: [SourceRegistryService, ResearchService, DossierService],
})
export class IntelModule {}
