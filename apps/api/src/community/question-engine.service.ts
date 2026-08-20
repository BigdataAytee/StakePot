import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { MarketDraft } from '@prisma/client';

import { logger } from '../logger';
import { BriefingService, type SlotBriefing } from '../intel/briefing.service';
import { MarketHealthService } from '../market/health.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { QuestionEngineUnavailableError } from './anthropic-question-model';
import {
  byQueuePriority,
  CATALOGUE_SLOTS,
  CATALOGUE_SLOT_NAMES,
  draftScore,
  duplicateOf,
  isCatalogueSlot,
  withinBalanceBand,
  type CatalogueSlot,
} from './draft-ranking';
import {
  blockersOf,
  isBalanced,
  screenTemplate,
  type MarketTemplate,
  type RuleReport,
} from './market-template';
import { templateOf, type Assessment, type Proposal, type QuestionModel } from './question-model';

export { QuestionEngineUnavailableError };
export type { Assessment };

/**
 * The model seam, as an injection token.
 *
 * A token rather than a concrete class so the rules can be exercised with a
 * stand-in — and so "no API key" is a value the container provides (null)
 * rather than a branch buried in a constructor.
 */
export const QUESTION_MODEL = Symbol('stakeam:question-model');

export interface GeneratedDraft {
  readonly draftId: string;
  readonly slot: CatalogueSlot;
  readonly state: 'suggested' | 'rejected';
  readonly score: number;
  readonly question: string;
  readonly refusals: readonly string[];
}

export interface CopilotResult {
  readonly template: MarketTemplate;
  readonly estimates: readonly number[];
  readonly balanced: boolean;
  readonly engagement: number;
  readonly rationale: string;
  /** The whole checklist, not just what failed — the wizard renders every line. */
  readonly report: RuleReport;
}

/**
 * §2.9 — the AI market question engine.
 *
 * "It **suggests; humans approve** — no market ever goes live without staff
 * sign-off." Nothing in this service opens a market. It writes scored rows into
 * `market_drafts`, and a person opens them from the queue.
 *
 * The division of labour is deliberate and is the whole design: the model
 * proposes and estimates; every *decision* — the Rulebook blocklist, the
 * structural checklist, the balance band, duplicates, catalogue discipline,
 * rank — is made by code in `market-template.ts` and `draft-ranking.ts`, which
 * run without a network call and are tested without an API key. A rule that
 * lives only in a system prompt is a preference.
 *
 * Refusals are stored, not dropped. A queue that shows only what the engine
 * liked tells you nothing about what it is doing.
 */
@Injectable()
export class QuestionEngineService {
  private readonly model: QuestionModel | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
    private readonly health: MarketHealthService,
    private readonly briefings: BriefingService,
    @Inject(QUESTION_MODEL) model: QuestionModel | null,
  ) {
    this.model = model;
  }

  private ask(): QuestionModel {
    if (this.model === null) throw new QuestionEngineUnavailableError();
    return this.model;
  }

  // ------------------------------------------------------------ screening mode

  /**
   * Screen a submission and file it for review.
   *
   * A first-time creator always routes to human review regardless of verdict
   * (§2.9) — that is the anti-farming gate rather than a quality one.
   */
  async screen(params: {
    template: MarketTemplate;
    creatorId: string;
    isFirstMarket: boolean;
    /** The activation path the creator chose at creation (§2.4). */
    activationPath?: 'organic' | 'seeded';
    /** Rules 5 and 16, attested by the creator on the way in. */
    attestedNoInfluence?: boolean;
    now?: Date;
  }): Promise<{
    draftId: string;
    state: 'suggested' | 'rejected';
    report: RuleReport;
    assessment: Assessment | null;
  }> {
    const now = params.now ?? new Date();
    const report = screenTemplate(
      params.template,
      { now, attestedNoInfluence: params.attestedNoInfluence ?? false },
      'community',
    );

    // The checklist is decided here, not by the model. A prohibition that only
    // exists in a prompt is a preference.
    //
    // Failures only, not `blocked`. The checklist's two judgement questions —
    // the front-page test and the stranger test — are answered by the staff
    // member who approves the market, and that person is not in the room when a
    // creator presses submit. Refusing the submission because they have not
    // answered yet would refuse every community market ever made. The
    // unanswered questions ride into the queue on the report instead, which is
    // where they get asked.
    if (report.failures.length > 0) {
      const draft = await this.fileCommunityDraft(params, report, null, 'rejected');
      return { draftId: draft.id, state: 'rejected', report, assessment: null };
    }

    const assessment = await this.ask().assess(params.template);
    const balanced = isBalanced(assessment.balanceEstimates, await this.bounds());
    const state =
      assessment.verdict === 'reject' || assessment.influenceable || !assessment.sourceSettles
        ? 'rejected'
        : 'suggested';

    const draft = await this.fileCommunityDraft(params, report, { ...assessment, balanced }, state);
    return { draftId: draft.id, state, report, assessment };
  }

  // ----------------------------------------------------------- generation mode

  /**
   * Draft replacements for the official shelf (§2.9 rules 1–8).
   *
   * One proposal per free slot: rule 8 asks for "replacements per cycle, not
   * additions", so a slot already carrying a live market is not asked about.
   * Everything that comes back is gated before it is filed, and a proposal that
   * fails is filed as a refusal with its reasons rather than discarded.
   */
  async generate(
    params: { now?: Date; slots?: readonly CatalogueSlot[] } = {},
  ): Promise<GeneratedDraft[]> {
    const now = params.now ?? new Date();
    const model = this.ask();

    const live = await this.prisma.market.findMany({
      where: {
        shelf: 'official',
        state: { in: ['active', 'frozen', 'pending_resolution', 'dispute_window'] },
      },
      select: { id: true, question: true },
    });
    const pending = await this.prisma.marketDraft.findMany({
      where: { source: 'ai', state: 'suggested' },
      select: { templateJson: true },
    });

    const avoid = [
      ...live.map((market) => market.question),
      ...pending.map((draft) => (draft.templateJson as { question?: string }).question ?? ''),
    ].filter((question) => question.length > 0);

    const slots = params.slots ?? (await this.freeSlots(live.length));
    const results: GeneratedDraft[] = [];

    // §2.9's loop: the engine's own hits become examples, and the series that
    // ran lopsided come back as thresholds to retune rather than repeat.
    const [exemplars, retune] = await Promise.all([this.exemplars(), this.lopsided()]);

    for (const slot of slots) {
      // What the pipeline has actually read about this slot in the last
      // fortnight. The same object goes into the prompt and onto the draft, so
      // the evidence panel a reviewer reads is the evidence the model saw —
      // rebuilding it at review time would show today's news beside a question
      // written from last week's, which reads as a citation and is not one.
      const evidence = await this.briefings.forSlot({
        brief: CATALOGUE_SLOTS[slot].brief,
        now,
      });

      let proposal: Proposal;
      try {
        proposal = await model.propose({
          slot,
          brief: CATALOGUE_SLOTS[slot].brief,
          avoid,
          exemplars,
          retune,
          evidence,
          now,
        });
      } catch (error) {
        logger.error(
          { slot, error: error instanceof Error ? error.message : String(error) },
          'question engine could not draft for this slot',
        );
        continue;
      }

      results.push(await this.fileProposal({ proposal, slot, live, now, evidence }));
      avoid.push(proposal.question);
    }

    return results;
  }

  /**
   * Gate one proposal and file it, accepted or refused.
   *
   * The order matters: the Rulebook's own prohibitions run first, then the
   * structural checklist, then balance, then duplication. A proposal about a
   * banned topic is not "unbalanced" — it is out, and the reason it is out
   * should say so.
   */
  private async fileProposal(input: {
    proposal: Proposal;
    slot: CatalogueSlot;
    live: readonly { id: string; question: string }[];
    now: Date;
    evidence?: SlotBriefing;
  }): Promise<GeneratedDraft> {
    const { proposal, slot, live, now } = input;
    const template = templateOf(proposal);
    const refusals: string[] = [];

    // The AI surface of the checklist. Rules 5 and 16 are carried by the
    // model's own influence judgement rather than by an attestation nobody is
    // present to give — the model is required to state it, and stating it
    // wrongly is what the reviewer is there to catch.
    const report = screenTemplate(
      template,
      {
        now,
        attestedNoInfluence: !proposal.influenceable,
        expectedNewsFlow: proposal.newsExpected,
      },
      'ai',
    );
    refusals.push(...blockersOf(report));

    // §2.9 and the checklist both ask the engine to throw its own work away
    // rather than lower the bar. When it does, the reason it gives is the
    // useful part: a draft it could not write is the cheapest signal there is
    // about what the shelf is short of, and it is invisible unless logged.
    if (proposal.rejected) {
      refusals.push(
        `the engine rejected its own draft — ${proposal.rejectionReason} (rules ${proposal.rejectedRules.join(', ')})`,
      );
    }

    if (!isCatalogueSlot(proposal.slot)) {
      refusals.push(`"${proposal.slot}" is not a slot on the shelf plan`);
    }

    const bounds = await this.bounds();
    if (!withinBalanceBand(proposal.balanceEstimates, bounds)) {
      refusals.push(
        `the engine's own estimate is outside the band — ` +
          `${proposal.balanceEstimates.map((value) => Math.round(value * 100)).join('/')}`,
      );
    }

    const threshold = await this.config.get('ai_duplicate_threshold');
    const duplicate = duplicateOf(proposal.question, live, threshold);
    if (duplicate !== null) {
      refusals.push(`restates a live market: "${duplicate.question}"`);
    }

    const score = draftScore({
      engagement: proposal.engagementScore,
      estimates: proposal.balanceEstimates,
    });
    const state = refusals.length === 0 ? 'suggested' : 'rejected';

    const draft = await this.prisma.marketDraft.create({
      data: {
        source: 'ai',
        templateJson: JSON.parse(JSON.stringify(template)) as object,
        balanceEstimate: Math.max(...proposal.balanceEstimates, 0),
        engagementScore: proposal.engagementScore,
        blocklistFlags: {
          slot,
          score,
          rationale: proposal.rationale,
          estimates: proposal.balanceEstimates,
          refusals,
          report: JSON.parse(JSON.stringify(report)) as object,
          selfRejected: proposal.rejected,
          duplicateOf: duplicate?.id ?? null,
        } as Prisma.InputJsonValue,
        // Written even on a refused draft. A draft the engine threw away is the
        // cheapest signal there is about what the shelf is short of, and the
        // reading behind it is what tells a reviewer whether the refusal was
        // right — "nothing published about this in a fortnight" and "four
        // sources disagree about the number" are very different refusals.
        ...(input.evidence === undefined
          ? {}
          : { evidenceJson: JSON.parse(JSON.stringify(input.evidence)) as Prisma.InputJsonValue }),
        state,
      },
    });

    return {
      draftId: draft.id,
      slot,
      state,
      score,
      question: proposal.question,
      refusals,
    };
  }

  // ------------------------------------------------------------- co-pilot mode

  /**
   * §2.14a step 2: "AI restructure (live)".
   *
   * Turns what a creator typed into the full template and hands back the balance
   * estimate the wizard's meter shows. It files nothing — this is the creator
   * still typing, and a draft row per keystroke would be noise in the queue.
   */
  async copilot(params: { text: string; now?: Date }): Promise<CopilotResult> {
    const now = params.now ?? new Date();
    if (params.text.trim().length < 10) {
      throw new Error('say a bit more about what you want people to call');
    }

    const proposal = await this.ask().restructure({ text: params.text.trim(), now });
    const template = templateOf(proposal);

    return {
      template,
      estimates: proposal.balanceEstimates,
      balanced: isBalanced(proposal.balanceEstimates, await this.bounds()),
      engagement: proposal.engagementScore,
      rationale: proposal.rationale,
      report: screenTemplate(
        template,
        {
          now,
          attestedNoInfluence: !proposal.influenceable,
          expectedNewsFlow: proposal.newsExpected,
        },
        'community',
      ),
    };
  }

  /** Re-check an edited template: the meter has to move while they type. */
  async checkBalance(params: {
    template: MarketTemplate;
    now?: Date;
  }): Promise<Omit<CopilotResult, 'template'>> {
    const now = params.now ?? new Date();
    const assessment = await this.ask().assess(params.template);

    return {
      estimates: assessment.balanceEstimates,
      balanced: isBalanced(assessment.balanceEstimates, await this.bounds()),
      engagement: assessment.engagementScore,
      rationale: assessment.reason,
      report: screenTemplate(
        params.template,
        { now, attestedNoInfluence: !assessment.influenceable },
        'community',
      ),
    };
  }

  // -------------------------------------------------------- the feedback loop

  /**
   * §2.9's feedback loop, written when a market settles.
   *
   * "After each market resolves, log `initial_pool_split`, `final_pool_split`,
   * `volume`, `dispute_count` against the question's features. Questions that
   * ran lopsided (>[75/25]) are flagged... High-volume, low-dispute,
   * near-balanced questions become few-shot exemplars."
   *
   * The splits are money, not prices: what the crowd actually put where. A
   * market can look balanced on the chart and still have taken 90% of its money
   * on one side, and it is the money that decides whether the question earned
   * anything.
   */
  async recordOutcome(marketId: string): Promise<void> {
    const market = await this.prisma.market.findUnique({
      where: { id: marketId },
      include: { outcomes: true },
    });
    if (market === null || market.outcomes.length === 0) return;

    const staked = market.outcomes.map((outcome) => Number(outcome.stakedTotal));
    const pot = staked.reduce((sum, value) => sum + value, 0);
    const finalSplit = pot > 0 ? Math.max(...staked) / pot : 0;

    const [volume, disputeCount, warnings] = await Promise.all([
      this.prisma.trade.aggregate({
        where: { marketId, side: { not: 'seed' } },
        _sum: { cost: true },
      }),
      this.prisma.dispute.count({ where: { marketId } }),
      // Checklist rule 43: the post-mortem the engine trains on is "volume,
      // final split, disputes, what you'd change". The first three were here
      // already; the fourth is which Part 5 flags fired while it was live.
      this.health.historyFor(marketId),
    ]);
    const warningsFired = [...new Set(warnings.map((warning) => warning.rule))].sort();

    await this.prisma.marketOutcomeLog.upsert({
      where: { marketId },
      create: {
        marketId,
        // Every market opens flat, by construction: a seed moves no price and
        // official markets open on their seed.
        initialSplit: new Prisma.Decimal(1 / market.outcomes.length),
        finalSplit: new Prisma.Decimal(finalSplit),
        volume: new Prisma.Decimal(volume._sum.cost?.toString() ?? '0'),
        disputeCount,
        warningsFired,
      },
      update: {
        finalSplit: new Prisma.Decimal(finalSplit),
        volume: new Prisma.Decimal(volume._sum.cost?.toString() ?? '0'),
        disputeCount,
        warningsFired,
      },
    });
  }

  /**
   * The engine's own hits, for the next generation cycle's few-shot examples.
   *
   * Near-balanced, high-volume, undisputed — in that order of importance,
   * because §2.9's directive is disagreement and the backtest is what says
   * disagreement is worth money.
   */
  async exemplars(limit = 5) {
    const logs = await this.prisma.marketOutcomeLog.findMany({
      include: { market: { select: { question: true, shelf: true } } },
      take: 100,
    });

    return logs
      .filter(
        (log) =>
          Number(log.finalSplit) <= 0.65 &&
          log.disputeCount === 0 &&
          // A market that tripped a Part 5 flag is not a model answer, however
          // well it ended. Handing the engine a question that ran 85/15 for a
          // week as something to imitate is how the next batch inherits the
          // same shape — checklist rule 43, whose whole point is that the
          // post-mortem changes what gets generated next.
          log.warningsFired.length === 0,
      )
      .sort((a, b) => Number(b.volume) - Number(a.volume))
      .slice(0, limit)
      .map((log) => ({
        question: log.market.question,
        finalSplit: Number(log.finalSplit),
        volume: log.volume.toString(),
      }));
  }

  /**
   * Series that ran lopsided (>75/25) and want their threshold retuned.
   *
   * Handed to the next cycle as things to avoid restating in the same shape —
   * §2.9's "the engine is instructed to retune that series' threshold".
   */
  async lopsided(limit = 5) {
    const logs = await this.prisma.marketOutcomeLog.findMany({
      include: { market: { select: { question: true } } },
      take: 100,
    });

    return logs
      .filter((log) => Number(log.finalSplit) > 0.75)
      .sort((a, b) => Number(b.finalSplit) - Number(a.finalSplit))
      .slice(0, limit)
      .map((log) => ({ question: log.market.question, finalSplit: Number(log.finalSplit) }));
  }

  // ------------------------------------------------------------------ the queue

  /** §6.2's ranked drafts queue. Refusals last, and only when asked for. */
  async queue(params: { includeRejected?: boolean; limit?: number } = {}) {
    const drafts = await this.prisma.marketDraft.findMany({
      where: {
        state: params.includeRejected === true ? { in: ['suggested', 'rejected'] } : 'suggested',
      },
      orderBy: { createdAt: 'desc' },
      take: params.limit ?? 50,
    });

    return drafts.map((draft) => this.describeDraft(draft)).sort(byQueuePriority);
  }

  private describeDraft(draft: MarketDraft) {
    const flags = (draft.blocklistFlags ?? {}) as {
      slot?: string;
      score?: number;
      rationale?: string;
      estimates?: number[];
      refusals?: string[];
      reason?: string;
      concerns?: string[];
      firstMarket?: boolean;
      creatorId?: string;
    };
    const template = draft.templateJson as unknown as MarketTemplate;

    return {
      id: draft.id,
      source: draft.source,
      state: draft.state,
      slot: flags.slot ?? null,
      score:
        flags.score ??
        draftScore({
          engagement: Number(draft.engagementScore),
          estimates: flags.estimates ?? [Number(draft.balanceEstimate)],
        }),
      question: template.question,
      outcomes: template.outcomes.map((outcome) => outcome.label),
      sourceName: template.sourceName,
      sourceUrl: template.sourceUrl,
      eventDate: template.eventDate,
      voidDate: template.voidDate,
      estimates: flags.estimates ?? [],
      engagement: Number(draft.engagementScore),
      rationale: flags.rationale ?? flags.reason ?? '',
      refusals: flags.refusals ?? flags.concerns ?? [],
      creatorId: flags.creatorId ?? null,
      firstMarket: flags.firstMarket ?? false,
      createdAt: draft.createdAt.toISOString(),
      evidence: (draft.evidenceJson as SlotBriefing | null) ?? null,
      template,
    };
  }

  // ---------------------------------------------------------------- internals

  private async bounds() {
    return {
      binaryLow: await this.config.get('ai_balance_low'),
      binaryHigh: await this.config.get('ai_balance_high'),
      multiMax: await this.config.get('ai_balance_multi_max'),
    };
  }

  /**
   * Which slots to draft for.
   *
   * The shelf plan is a budget, not a target: if six markets are already live,
   * this asks for nothing. Rule 8 wants replacements offered per cycle, so the
   * slots are handed out in order and only up to the number of free places.
   */
  private async freeSlots(liveCount: number): Promise<CatalogueSlot[]> {
    const size = await this.config.get('official_shelf_slots');
    const free = Math.max(0, size - liveCount);
    return CATALOGUE_SLOT_NAMES.slice(0, free);
  }

  private async fileCommunityDraft(
    params: {
      template: MarketTemplate;
      creatorId: string;
      isFirstMarket: boolean;
      activationPath?: 'organic' | 'seeded';
    },
    report: RuleReport,
    assessment: (Assessment & { balanced: boolean }) | null,
    state: 'suggested' | 'rejected',
  ) {
    // §2.9: "First-time creators always route to human review."
    //
    // Which every community submission already does — `suggested` means "in the
    // queue", and staff open the market from there. The line that used to sit
    // here read `isFirstMarket && state === 'suggested' ? 'suggested' : state`,
    // which is `state` on both branches: it looked like it enforced the rule
    // and enforced nothing. Deleting it changes no behaviour, which is exactly
    // the point — the routing was never what was missing.
    //
    // What was missing is the second half of §6.2: "first-time creators always
    // *flagged* for human review". The flag is filed below and the queue now
    // sorts on it, so a reviewer sees whose first market this is instead of it
    // sitting fourteenth by score behind a known creator's fourth.
    if (params.isFirstMarket) {
      logger.info(
        { creatorId: params.creatorId },
        'first market from this creator — flagged at the top of the review queue',
      );
    }

    return this.prisma.marketDraft.create({
      data: {
        source: 'community',
        templateJson: JSON.parse(JSON.stringify(params.template)) as object,
        balanceEstimate: assessment === null ? 0 : Math.max(...assessment.balanceEstimates),
        engagementScore: assessment?.engagementScore ?? 0,
        blocklistFlags: {
          // The whole report, not the failures. A reviewer opening this draft
          // needs to see which rules were checked and passed as much as which
          // ones bit — "clean" is only meaningful against a list.
          report: JSON.parse(JSON.stringify(report)) as object,
          concerns: assessment?.concerns ?? [],
          estimates: assessment?.balanceEstimates ?? [],
          balanced: assessment?.balanced ?? false,
          influenceable: assessment?.influenceable ?? false,
          duplicate: assessment?.duplicateOfLiveMarket ?? false,
          reason: assessment?.reason ?? blockersOf(report).join(' '),
          firstMarket: params.isFirstMarket,
          // Approval happens later and needs to know whose market this is, and
          // which activation path the creator picked (§2.4 — "the creator
          // chooses at creation", so it cannot be decided by the reviewer).
          creatorId: params.creatorId,
          activationPath: params.activationPath ?? 'organic',
        } as Prisma.InputJsonValue,
        state,
      },
    });
  }
}
