import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AdminAuditService } from '../audit/admin-audit.service';
import { SeedService } from '../community/seed.service';
import { screenTemplate, type MarketTemplate } from '../community/market-template';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';

export class OfficialMarketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficialMarketError';
  }
}

/**
 * Opening an official market from the drafts queue (§2.9, §6.2).
 *
 * "Admin panel shows ranked drafts with one-click 'open market' (pre-filled
 * template). Never autonomous publication." This is the click: a person picks a
 * draft, the rules run again, the platform seeds it, and it opens.
 *
 * The screen runs a second time on purpose. A draft written last week can be
 * stale — a void date that has passed, an event that already happened — and the
 * moment of publication is the one that has to be defensible.
 */
@Injectable()
export class OfficialMarketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
    private readonly seeds: SeedService,
    private readonly audit: AdminAuditService,
  ) {}

  async openFromDraft(params: {
    draftId: string;
    staffId: string;
    ip: string;
    liquidityParam?: string;
    seedPerOutcome?: string;
    now?: Date;
  }): Promise<{ marketId: string; seeded: string }> {
    const now = params.now ?? new Date();

    const draft = await this.prisma.marketDraft.findUnique({ where: { id: params.draftId } });
    if (draft === null) throw new OfficialMarketError('no such draft');
    if (draft.state !== 'suggested') {
      throw new OfficialMarketError(`this draft is already ${draft.state}`);
    }
    if (draft.source !== 'ai') {
      throw new OfficialMarketError(
        'community submissions open through the community path, with their creator and their bond',
      );
    }

    const template = draft.templateJson as unknown as MarketTemplate;
    const problems = screenTemplate(template, { now });
    if (problems.length > 0) {
      throw new OfficialMarketError(
        `this draft no longer passes the screen: ${problems.map((p) => p.message).join(' ')}`,
      );
    }

    const feeBps = await this.config.get('official_fee_bps');
    const liquidityParam = params.liquidityParam ?? '50000';

    const labels = [
      ...template.outcomes.map((outcome) => ({ label: outcome.label, isOther: false })),
      ...(template.otherLabel === undefined ? [] : [{ label: template.otherLabel, isOther: true }]),
    ];
    const criteria = Object.fromEntries(
      template.outcomes.map((outcome) => [outcome.label, outcome.criteria]),
    );

    const market = await this.prisma.market.create({
      data: {
        shelf: 'official',
        question: template.question,
        sourceName: template.sourceName,
        sourceUrl: template.sourceUrl,
        criteriaJson: criteria,
        edgeCasesJson: template.edgeCases as Prisma.InputJsonValue,
        eventDate: new Date(template.eventDate),
        voidDate: new Date(template.voidDate),
        liquidityParam: new Prisma.Decimal(liquidityParam),
        feeBps,
        // Created in `draft` and opened by the seed, so a market can never be
        // live for the instant between existing and having a pot.
        state: 'draft',
        outcomes: {
          create: labels.map((outcome, ordinal) => ({
            label: outcome.label,
            ordinal,
            isOther: outcome.isOther,
            priceCurrent: new Prisma.Decimal(1).div(labels.length),
          })),
        },
      },
    });

    const applied = await this.seeds.seedOfficial({
      marketId: market.id,
      ...(params.seedPerOutcome === undefined ? {} : { perOutcome: params.seedPerOutcome }),
    });

    await this.prisma.marketDraft.update({
      where: { id: draft.id },
      data: { state: 'approved', reviewedBy: params.staffId },
    });

    await this.audit.record({
      staffId: params.staffId,
      action: 'draft.open_official',
      targetRef: `market:${market.id}`,
      before: { draftId: draft.id, state: 'suggested' },
      after: {
        question: template.question,
        seedPerOutcome: applied.perOutcome.toString(),
        liquidityParam,
      },
      ip: params.ip,
    });

    return { marketId: market.id, seeded: applied.total.toString() };
  }

  /** Refuse a draft, with the reason kept on the row. */
  async rejectDraft(params: {
    draftId: string;
    staffId: string;
    reason: string;
    ip: string;
  }): Promise<void> {
    if (params.reason.trim().length < 5) {
      throw new OfficialMarketError('say why — the queue is also a record of what we turned down');
    }

    const draft = await this.prisma.marketDraft.findUnique({ where: { id: params.draftId } });
    if (draft === null) throw new OfficialMarketError('no such draft');
    if (draft.state !== 'suggested') {
      throw new OfficialMarketError(`this draft is already ${draft.state}`);
    }

    const flags = (draft.blocklistFlags ?? {}) as Record<string, unknown>;
    await this.prisma.marketDraft.update({
      where: { id: draft.id },
      data: {
        state: 'rejected',
        reviewedBy: params.staffId,
        blocklistFlags: {
          ...flags,
          refusals: [
            ...((flags['refusals'] as string[] | undefined) ?? []),
            `reviewer: ${params.reason.trim()}`,
          ],
        } as Prisma.InputJsonValue,
      },
    });

    await this.audit.record({
      staffId: params.staffId,
      action: 'draft.reject',
      targetRef: `draft:${draft.id}`,
      after: { reason: params.reason.trim() },
      ip: params.ip,
    });
  }
}
