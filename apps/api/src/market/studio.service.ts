import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  LOPSIDED_SPLIT,
  review,
  type ReviewContext,
  type RuleReport,
  type TicketDraft,
} from '@stakeam/rules';

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
   * The starter templates, retired ones included.
   *
   * The public `/community/templates` endpoint returns only what is active,
   * because a creator should never be offered a template a submission would be
   * refused for citing. Staff need the other half: a retired template is a
   * decision somebody made, and it is only reviewable if it is visible.
   */
  async templates() {
    const rows = await this.prisma.ticketTemplate.findMany({ orderBy: { id: 'asc' } });
    return rows.map((row) => {
      const template = row.templateJson as { name?: string; question?: string } | null;
      return {
        id: row.id,
        category: row.category,
        active: row.active,
        name: template?.name ?? row.id,
        question: template?.question ?? '',
      };
    });
  }

  /**
   * Markets worth running again, with what happened last time.
   *
   * The MPC meets every two months whether or not anybody drafts a question
   * about it, and re-typing the same market from scratch each cycle is how the
   * criteria drift. So this offers the settled ones back — but never on their
   * own. Each carries its final split, its volume, and any Part 5 flag that
   * fired, because checklist rule 35 says a market that ran past 75/25 wants
   * its threshold retuned rather than repeated, and an operator cannot retune
   * what they cannot see.
   */
  async repeatable(limit = 20) {
    const settled = await this.prisma.market.findMany({
      where: { shelf: 'official', state: 'resolved' },
      orderBy: { eventDate: 'desc' },
      take: limit,
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
    if (settled.length === 0) return [];

    const ids = settled.map((market) => market.id);
    const [logs, flags] = await Promise.all([
      this.prisma.marketOutcomeLog.findMany({ where: { marketId: { in: ids } } }),
      this.prisma.marketHealthFlag.findMany({
        where: { marketId: { in: ids } },
        select: { marketId: true, rule: true },
      }),
    ]);

    const logBy = new Map(logs.map((log) => [log.marketId, log]));
    const flagsBy = new Map<string, string[]>();
    for (const flag of flags) {
      flagsBy.set(flag.marketId, [...(flagsBy.get(flag.marketId) ?? []), flag.rule]);
    }

    return settled.map((market) => {
      const log = logBy.get(market.id);
      const fired = [...new Set(flagsBy.get(market.id) ?? [])].sort();
      const finalSplit = log === undefined ? null : Number(log.finalSplit.toString());
      return {
        id: market.id,
        question: market.question,
        sourceName: market.sourceName,
        eventDate: market.eventDate.toISOString(),
        volume: log === undefined ? '0' : log.volume.toString(),
        finalSplit,
        disputes: log?.disputeCount ?? 0,
        warningsFired: fired,
        // The advice, said once and plainly, so it is not left as an inference
        // from two numbers on a row.
        retune:
          finalSplit !== null && finalSplit > LOPSIDED_SPLIT
            ? `Ran ${Math.round(finalSplit * 100)}/${100 - Math.round(finalSplit * 100)}. Move the threshold before running it again.`
            : fired.includes('35')
              ? 'Was flagged lopsided while it was live, even though it settled closer. Worth a look at the threshold.'
              : null,
      };
    });
  }

  /**
   * The next market in a series, as a draft — never as a published market.
   *
   * Copies the question, the outcomes and the criteria, and rolls the dates
   * forward by the cadence the operator picked. It publishes nothing: what
   * comes back goes into the wizard, where the whole checklist runs on it like
   * any other draft. That matters more than the convenience — a repeat is
   * exactly the kind of market that gets published on the strength of the last
   * one having been fine.
   *
   * The date is arithmetic on the previous event date rather than a guess at
   * when the next MPC sits, and the operator is expected to correct it. Rule 2
   * catches a date in the past; nothing but a person catches a date that is
   * merely wrong, which is why this hands over a draft rather than a market.
   */
  async nextInSeries(params: {
    marketId: string;
    cadence: 'weekly' | 'fortnightly' | 'monthly';
  }): Promise<TicketDraft> {
    const market = await this.prisma.market.findUnique({
      where: { id: params.marketId },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
    if (market === null) throw new StudioError('that market no longer exists');

    const criteria = asRecord(market.criteriaJson);
    const roll = (from: Date): Date => {
      const next = new Date(from.getTime());
      if (params.cadence === 'weekly') next.setUTCDate(next.getUTCDate() + 7);
      else if (params.cadence === 'fortnightly') next.setUTCDate(next.getUTCDate() + 14);
      else next.setUTCMonth(next.getUTCMonth() + 1);
      return next;
    };

    const eventDate = roll(market.eventDate);
    // The void window is kept at whatever the last one used rather than reset
    // to a default: it was chosen for how long this source takes to publish,
    // and that does not change because the date did.
    const voidGapMs = market.voidDate.getTime() - market.eventDate.getTime();

    return {
      question: market.question,
      outcomes: market.outcomes
        .filter((outcome) => !outcome.isOther)
        .map((outcome) => ({
          label: outcome.label,
          criteria: criteria[outcome.label] ?? '',
        })),
      ...(market.outcomes.find((outcome) => outcome.isOther) === undefined
        ? {}
        : { otherLabel: market.outcomes.find((outcome) => outcome.isOther)?.label }),
      sourceName: market.sourceName,
      sourceUrl: market.sourceUrl,
      eventDate: eventDate.toISOString(),
      voidDate: new Date(eventDate.getTime() + voidGapMs).toISOString(),
      edgeCases: asRecord(market.edgeCasesJson) as Record<string, string>,
    };
  }

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

/** A jsonb column as an object, or an empty one. Never null, never an array. */
function asRecord(value: unknown): Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, string>)
    : {};
}
