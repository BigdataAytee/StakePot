import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma, type ResolutionDossier } from '@prisma/client';
import { maySettle } from '@stakeam/rules';

import { AdminAuditService } from '../audit/admin-audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  RESOLUTION_ANALYST,
  type EvidenceItem,
  type ResolutionAnalyst,
} from './resolution-analyst';

export class DossierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DossierError';
  }
}

/**
 * Below this, the dossier says "review this for a void" instead of naming an
 * outcome. Set high on purpose: a dossier's job is to save a staff member
 * twenty minutes of reading, not to make a marginal call on their behalf.
 */
const CONFIDENCE_FLOOR = 0.75;

/**
 * The resolution dossier: everything a staff member needs to decide, assembled
 * before they open the market.
 *
 * **This service cannot settle a market, and that is structural rather than a
 * promise.** It has no reference to the resolution flow, no way to construct
 * the staff actor that flow requires, and no write access to `resolutions`,
 * `markets.state` or the ledger. What it writes is one row in
 * `resolution_dossiers`, which nothing reads except a screen a person is
 * looking at. `dossier.integration.test.ts` asserts each of those separately,
 * because "the service does not call it" is the kind of fact that stays true
 * until somebody adds a convenience method.
 *
 * The human path is unchanged: one staff member proposes with a source link, a
 * second confirms, and the 48-hour dispute window runs before a naira moves.
 */
@Injectable()
export class DossierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    @Optional()
    @Inject(RESOLUTION_ANALYST)
    private readonly analyst: ResolutionAnalyst | null = null,
  ) {}

  /**
   * Assemble the dossier for one market.
   *
   * Idempotent per market: re-running replaces the row rather than stacking
   * them, because a dossier is a current reading and a queue of stale ones is
   * a queue somebody has to date-check by hand.
   */
  async build(params: { marketId: string; now?: Date }): Promise<ResolutionDossier> {
    const now = params.now ?? new Date();
    const market = await this.prisma.market.findUnique({
      where: { id: params.marketId },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
    if (market === null) throw new DossierError('no such market');

    const evidence = await this.evidenceFor(market.id);

    // The named source, and whether it has said anything at all. This is the
    // question that decides most dossiers: a market settles against one body's
    // publication, and if that body has not published, there is nothing to
    // read however much else has been written.
    const fromResolutionSource = evidence.filter((item) => maySettle(item.tier));

    if (this.analyst === null) {
      // No key configured. Fail closed and *say so on the row* rather than
      // writing a confident-looking empty dossier: a staff member opening a
      // market must be able to tell "nothing to report" from "nobody looked".
      return this.write({
        marketId: market.id,
        proposedOutcomeId: null,
        confidence: 0,
        recommendVoid: false,
        reasoning:
          'No analysis was run — the question engine is not configured. Resolve this market by reading the named source directly.',
        evidence,
        conflicts: [],
        now,
      });
    }

    const reading = await this.analyst.read({
      question: market.question,
      criteria: asRecord(market.criteriaJson),
      edgeCases: asRecord(market.edgeCasesJson),
      outcomes: market.outcomes.map((outcome) => outcome.label),
      sourceName: market.sourceName,
      sourceUrl: market.sourceUrl,
      eventDate: market.eventDate.toISOString(),
      evidence,
      now,
    });

    // Three separate reasons to refuse to name an outcome, kept separate on
    // purpose. "The source said nothing" and "the sources disagree" are
    // different problems with different remedies, and a single `recommendVoid`
    // boolean with no reason attached would send both to the same shrug.
    const silent = fromResolutionSource.length === 0;
    const conflicted = reading.conflicts.length > 0;
    const unsure = reading.confidence < CONFIDENCE_FLOOR;
    const recommendVoid = reading.recommendVoid || silent || conflicted || unsure;

    const matched = market.outcomes.find(
      (outcome) => outcome.label.toLowerCase() === (reading.outcomeLabel ?? '').toLowerCase(),
    );

    return this.write({
      marketId: market.id,
      // No proposal at all when anything above fired. A dossier that names an
      // outcome *and* recommends a void is asking the reader to ignore one of
      // its own sentences.
      proposedOutcomeId: recommendVoid ? null : (matched?.id ?? null),
      confidence: reading.confidence,
      recommendVoid,
      reasoning: [
        reading.reasoning,
        silent ? `${market.sourceName} has published nothing usable for this market yet.` : '',
        conflicted ? 'Sources disagree on the deciding fact — see the conflicts below.' : '',
        unsure && !reading.recommendVoid
          ? `Confidence ${(reading.confidence * 100).toFixed(0)}% is below the ${CONFIDENCE_FLOOR * 100}% this platform will name an outcome on.`
          : '',
        reading.recommendVoid && reading.voidReason.trim().length > 0 ? reading.voidReason : '',
      ]
        .filter((line) => line.trim().length > 0)
        .join('\n\n'),
      evidence,
      conflicts: reading.conflicts,
      now,
    });
  }

  /**
   * What a staff member reads. Null when nothing has been assembled.
   *
   * Deliberately a plain read with no side effect: opening the Resolution
   * Centre must not be what causes a dossier to exist, or the first person to
   * look at a market gets a different screen from the second.
   */
  async forMarket(marketId: string): Promise<ResolutionDossier | null> {
    return this.prisma.resolutionDossier.findUnique({ where: { marketId } });
  }

  /**
   * Record that a human acted on it, and whether they agreed.
   *
   * The training signal, and the only thing that makes the dossier
   * accountable: a reading nobody ever contradicted is indistinguishable from
   * a reading nobody read.
   */
  async recordDecision(params: {
    marketId: string;
    staffId: string;
    accepted: boolean;
    ip: string;
  }): Promise<void> {
    const dossier = await this.prisma.resolutionDossier.findUnique({
      where: { marketId: params.marketId },
    });
    if (dossier === null) return;

    await this.prisma.resolutionDossier.update({
      where: { marketId: params.marketId },
      data: { reviewedAt: new Date(), reviewedBy: params.staffId, accepted: params.accepted },
    });

    await this.audit.record({
      staffId: params.staffId,
      action: 'dossier.reviewed',
      targetRef: `market:${params.marketId}`,
      before: {
        proposedOutcomeId: dossier.proposedOutcomeId,
        confidence: dossier.confidence.toString(),
        recommendVoid: dossier.recommendVoid,
      },
      after: { accepted: params.accepted },
      ip: params.ip,
    });
  }

  /** Everything collected for this market, newest first, tier 3 excluded. */
  private async evidenceFor(marketId: string): Promise<EvidenceItem[]> {
    const links = await this.prisma.marketSourceItem.findMany({
      where: { marketId },
      orderBy: [{ relevance: 'desc' }],
      take: 40,
      include: { item: { include: { source: true } } },
    });

    // Signals never reach a dossier. They inform where a threshold is set at
    // creation; letting them argue about a *result* would put a forecast
    // market's odds into the reasoning behind a settlement.
    return links
      .filter((link) => link.item.source.tier !== 'signal')
      .map((link) => ({
        sourceName: link.item.source.name,
        tier: link.item.source.tier,
        headline: link.item.headline,
        url: link.item.url,
        publishedAt: link.item.publishedAt.toISOString(),
        facts: asRecord(link.item.factsJson) as Record<string, string | number>,
        clusterSize: 1,
      }));
  }

  private async write(input: {
    marketId: string;
    proposedOutcomeId: string | null;
    confidence: number;
    recommendVoid: boolean;
    reasoning: string;
    evidence: readonly EvidenceItem[];
    conflicts: readonly unknown[];
    now: Date;
  }): Promise<ResolutionDossier> {
    const data = {
      proposedOutcomeId: input.proposedOutcomeId,
      confidence: new Prisma.Decimal(input.confidence),
      recommendVoid: input.recommendVoid,
      reasoning: input.reasoning,
      evidenceJson: JSON.parse(JSON.stringify(input.evidence)) as Prisma.InputJsonValue,
      conflictsJson: JSON.parse(JSON.stringify(input.conflicts)) as Prisma.InputJsonValue,
      builtAt: input.now,
      // A rebuild is a new reading, so the old review no longer applies.
      reviewedAt: null,
      reviewedBy: null,
      accepted: null,
    };

    return this.prisma.resolutionDossier.upsert({
      where: { marketId: input.marketId },
      create: { marketId: input.marketId, ...data },
      update: data,
    });
  }
}

function asRecord(value: unknown): Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, string>)
    : {};
}
