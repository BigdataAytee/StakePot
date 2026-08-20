import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { review, type ReviewContext, type RuleReport, type TicketDraft } from '@stakeam/rules';

import { AdminAuditService } from '../audit/admin-audit.service';
import { duplicateOf } from '../community/draft-ranking';
import { SeedService } from '../community/seed.service';
import { blockersOf } from '../community/market-template';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';

export class StudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioError';
  }
}

/**
 * The Market Studio's own service: reviewing a draft, and publishing one.
 *
 * Separate from `OfficialMarketService` because that one opens a *draft the
 * engine wrote*, and this one opens *a market a person is writing now*. They
 * share the checklist and the seeding, and nothing else: the queue path has a
 * draft row to mark approved and a score to honour, and the studio path has a
 * wizard that has been asking the same questions live for the last five
 * minutes.
 *
 * What they must never differ on is the verdict. Both call `review()` with the
 * `wizard` surface and both refuse on `blocked`, so a market that the review
 * screen showed as clear cannot be refused by the service, and — the direction
 * that actually matters — a market the screen showed as failing cannot be
 * published by calling the endpoint directly.
 */
@Injectable()
export class StudioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
    private readonly seeds: SeedService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * Run the whole checklist over a draft, with the facts only the database
   * knows filled in.
   *
   * The wizard calls this on every step and the review screen calls it before
   * publishing. Same call, same answer — a review screen that ran a different
   * check from the one the wizard had been showing would be the worst of both:
   * a reviewer surprised at the last step by a rule they were never warned
   * about, or reassured by one that no longer applies.
   */
  async reviewDraft(
    draft: TicketDraft,
    answers: {
      attestedNoInfluence?: boolean;
      confirmations?: Record<string, boolean>;
      now?: Date;
    } = {},
  ): Promise<RuleReport> {
    const now = answers.now ?? new Date();
    const context = await this.contextFor(draft, now);

    return review(
      draft,
      {
        ...context,
        attestedNoInfluence: answers.attestedNoInfluence ?? false,
        confirmations: answers.confirmations ?? {},
      },
      'wizard',
    );
  }

  /**
   * Everything the checklist asks about that is not in the draft.
   *
   * Each lookup is here rather than in the validators on purpose: `review()` is
   * a pure function over facts, and the facts come from whichever caller has a
   * database. A fact this method cannot supply stays undefined, and the report
   * says "not checked" rather than "fine" — the distinction the whole package
   * is built around.
   */
  private async contextFor(draft: TicketDraft, now: Date): Promise<ReviewContext> {
    const live = await this.prisma.market.findMany({
      where: { state: { in: ['seeding', 'funding', 'active', 'frozen'] } },
      select: { id: true, question: true, eventDate: true },
    });

    // Rule 21. The same similarity the engine uses on its own drafts, so the
    // wizard and the queue cannot disagree about what counts as a duplicate.
    const threshold = await this.config.get('ai_duplicate_threshold');
    const duplicate = duplicateOf(draft.question, live, threshold);

    // Rule 33. Same calendar day, in the market's own zone — settlements are
    // scheduled by a person looking at a Nigerian calendar, not at UTC.
    //
    // Undefined rather than zero when there is no usable date yet. The wizard
    // reviews on every keystroke, so it spends most of a session asking about a
    // market with no event date at all: the first version called `dayKey` on
    // `new Date('')` and threw `RangeError: Invalid time value` out of the
    // endpoint, which the wizard rendered as "Internal server error" where the
    // checklist should have been. Reporting zero collisions instead would have
    // been quieter and worse — a clean pass on a calendar nobody could check.
    const eventDay = dayKey(new Date(draft.eventDate));
    const settlingSameDay =
      eventDay === null
        ? undefined
        : live.filter((market) => dayKey(market.eventDate) === eventDay).length;

    return {
      now,
      duplicates: duplicate === null ? [] : [{ id: duplicate.id, question: duplicate.question }],
      ...(settlingSameDay === undefined ? {} : { settlingSameDay }),
      liveCount: live.length,
      catalogueSlots: await this.config.get('official_shelf_slots'),
    };
  }

  /**
   * Publish a market written in the Studio.
   *
   * The checklist runs here, at the moment of publication, whatever the wizard
   * showed a minute ago. Time moves: a draft written before midnight can have a
   * void date in the past by the time somebody presses the button, and the
   * moment of publication is the one that has to be defensible.
   */
  async publish(params: {
    draft: TicketDraft;
    staffId: string;
    ip: string;
    liquidityParam?: string;
    seedPerOutcome?: string;
    attestedNoInfluence?: boolean;
    confirmations?: Record<string, boolean>;
    /** Why, when the reviewer is publishing over a warning (rule 6, 10, 33…). */
    warningReason?: string;
    now?: Date;
  }): Promise<{ marketId: string; seeded: string; report: RuleReport }> {
    const now = params.now ?? new Date();
    const draft = params.draft;

    const report = await this.reviewDraft(draft, {
      ...(params.attestedNoInfluence === undefined
        ? {}
        : { attestedNoInfluence: params.attestedNoInfluence }),
      ...(params.confirmations === undefined ? {} : { confirmations: params.confirmations }),
      now,
    });

    if (report.blocked) {
      throw new StudioError(`the checklist refuses this market: ${blockersOf(report).join(' ')}`);
    }

    // A warning is publishable — the checklist calls these commercial
    // judgements, and staff sometimes have a reason the software does not know.
    // What is not publishable is publishing over one silently: the reason is
    // required, and it goes to admin_audit with the warning it answers.
    if (report.warnings.length > 0 && (params.warningReason ?? '').trim().length < 5) {
      throw new StudioError(
        `this market carries ${report.warnings.length} warning${
          report.warnings.length === 1 ? '' : 's'
        } — say why you are publishing anyway`,
      );
    }

    const feeBps = await this.config.get('official_fee_bps');
    const liquidityParam = params.liquidityParam ?? '50000';

    const labels = [
      ...draft.outcomes.map((outcome) => ({ label: outcome.label, isOther: false })),
      ...(draft.otherLabel === undefined ? [] : [{ label: draft.otherLabel, isOther: true }]),
    ];
    const criteria = Object.fromEntries(
      draft.outcomes.map((outcome) => [outcome.label, outcome.criteria]),
    );

    const market = await this.prisma.market.create({
      data: {
        shelf: 'official',
        question: draft.question,
        sourceName: draft.sourceName,
        sourceUrl: draft.sourceUrl,
        criteriaJson: criteria,
        edgeCasesJson: draft.edgeCases as Prisma.InputJsonValue,
        eventDate: new Date(draft.eventDate),
        voidDate: new Date(draft.voidDate),
        liquidityParam: new Prisma.Decimal(liquidityParam),
        feeBps,
        // Created in `draft` and opened by the seed, so a market is never live
        // for the instant between existing and having a pot.
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

    // The whole report, not a verdict. An audit row saying "published, clean"
    // cannot be checked against anything later; one carrying the forty-nine
    // lines the reviewer saw can.
    await this.audit.record({
      staffId: params.staffId,
      action: 'studio.publish',
      targetRef: `market:${market.id}`,
      after: {
        question: draft.question,
        liquidityParam,
        seedPerOutcome: applied.perOutcome.toString(),
        report: JSON.parse(JSON.stringify(report)) as object,
        warningReason: params.warningReason ?? null,
      },
      ip: params.ip,
    });

    return { marketId: market.id, seeded: applied.total.toString(), report };
  }
}

/**
 * A calendar day in WAT.
 *
 * UTC+1 with no daylight saving, so the shift is a constant. Grouping
 * settlements by UTC day instead would split a Nigerian evening across two
 * dates and report no collision on the one day that had five.
 */
function dayKey(date: Date): string | null {
  if (!Number.isFinite(date.getTime())) return null;
  return new Date(date.getTime() + 3_600_000).toISOString().slice(0, 10);
}
