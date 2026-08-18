import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { env } from '../config/env';
import { logger } from '../logger';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  isBalanced,
  screenTemplate,
  type MarketTemplate,
  type TemplateProblem,
} from './market-template';

/** §2.9's assessment of one submission. Structured because free text is not a decision. */
const AssessmentSchema = z.object({
  balanceEstimates: z
    .array(z.number())
    .describe('Probability for each outcome, in the order given. Must sum to 1.'),
  engagementScore: z
    .number()
    .describe(
      '0-1. How much a Nigerian audience would care: naira, football, elections, BBNaija, fuel.',
    ),
  influenceable: z
    .boolean()
    .describe('True if a participant or the creator could affect the outcome.'),
  sourceSettles: z
    .boolean()
    .describe('True if the named source alone can settle every listed outcome.'),
  duplicateOfLiveMarket: z.boolean(),
  concerns: z.array(z.string()).describe('Short, specific problems a reviewer should see.'),
  verdict: z.enum(['looks_good', 'needs_review', 'reject']),
  reason: z.string().describe('One sentence, addressed to the creator. Plain, not apologetic.'),
});

export type Assessment = z.infer<typeof AssessmentSchema>;

export class QuestionEngineUnavailableError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY is not configured — the question engine cannot screen submissions');
    this.name = 'QuestionEngineUnavailableError';
  }
}

/**
 * §2.9's system prompt, condensed to what governs a *screen*. The generation
 * rules that draft official questions live with the generate path.
 */
const SCREENING_SYSTEM = `You screen prediction-market submissions for StakeAm, a Nigerian prediction market.

Your prime directive is genuine disagreement: a good market is one the audience splits close to 50/50 on. An obvious answer produces a dead market and negligible fees, so treat a lopsided estimate as a real problem, not a quibble.

Judge each submission on:
1. Balance — estimate the probability of each outcome honestly, in the order given. Do not flatter the submission.
2. Structure — a definite conclusion by a stated date, outcomes that are complete, and exactly one named official source that can settle every one of them.
3. Influence — reject anything a participant or the creator could affect, or would have inside knowledge of.
4. Engagement — Nigerian mass interest: the naira and cost of living, football, elections, BBNaija and entertainment, fuel.
5. Duplication — whether this restates a market already trading.

You advise; a human decides. Never approve anything about death, injury, illness, crime, violence, security incidents, private individuals, or an outcome with no checkable source — mark those 'reject'.

Write the reason for the creator, in plain Nigerian English. Be specific about what to change. Do not apologise.`;

/**
 * §2.9 — the AI market question engine, screening mode.
 *
 * "It **suggests; humans approve** — no market ever goes live without staff
 * sign-off." Nothing here writes a market; it writes a scored row into
 * `market_drafts` for the review queue.
 *
 * The deterministic screen in `market-template.ts` runs *first* and can reject
 * on its own. That ordering is the point: the Rulebook's prohibitions are not
 * delegated to a model, and a submission that fails them never reaches one.
 */
@Injectable()
export class QuestionEngineService {
  private readonly client: Anthropic | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
  ) {
    this.client = env.ANTHROPIC_API_KEY === undefined ? null : new Anthropic();
  }

  /**
   * Screen a submission and file it for review.
   *
   * Returns the draft row. A first-time creator always routes to human review
   * regardless of verdict (§2.9), which is the anti-farming gate rather than a
   * quality one.
   */
  async screen(params: {
    template: MarketTemplate;
    creatorId: string;
    isFirstMarket: boolean;
    /** The activation path the creator chose at creation (§2.4). */
    activationPath?: 'organic' | 'seeded';
    now?: Date;
  }): Promise<{
    draftId: string;
    state: 'suggested' | 'rejected';
    problems: TemplateProblem[];
    assessment: Assessment | null;
  }> {
    const now = params.now ?? new Date();
    const problems = screenTemplate(params.template, { now });

    // Rulebook §8 and the structural rules are decided here, not by the model.
    if (problems.length > 0) {
      const draft = await this.fileDraft(params, problems, null, 'rejected');
      return { draftId: draft.id, state: 'rejected', problems, assessment: null };
    }

    const assessment = await this.assess(params.template);
    const bounds = {
      binaryLow: await this.config.get('ai_balance_low'),
      binaryHigh: await this.config.get('ai_balance_high'),
      multiMax: await this.config.get('ai_balance_multi_max'),
    };

    const balanced = isBalanced(assessment.balanceEstimates, bounds);
    const state =
      assessment.verdict === 'reject' || assessment.influenceable || !assessment.sourceSettles
        ? 'rejected'
        : 'suggested';

    const draft = await this.fileDraft(params, problems, { ...assessment, balanced }, state);

    return { draftId: draft.id, state, problems, assessment };
  }

  /** Ask the model. Structured output only — §2.9 rule 1: free text is invalid. */
  private async assess(template: MarketTemplate): Promise<Assessment> {
    if (this.client === null) throw new QuestionEngineUnavailableError();

    const outcomes = template.outcomes
      .map((o, i) => `${i + 1}. ${o.label} — settles when: ${o.criteria}`)
      .join('\n');

    const response = await this.client.messages.parse({
      model: 'claude-opus-5',
      max_tokens: 16000,
      // Balance and influence are judgement calls on real-world facts, not
      // pattern matching — worth letting the model actually think about.
      thinking: { type: 'adaptive' },
      system: SCREENING_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            `Question: ${template.question}`,
            `Outcomes:\n${outcomes}`,
            template.otherLabel === undefined ? '' : `Catch-all bucket: ${template.otherLabel}`,
            `Official source: ${template.sourceName} (${template.sourceUrl})`,
            `Event date: ${template.eventDate}`,
            `Void date: ${template.voidDate}`,
            `Edge cases: ${JSON.stringify(template.edgeCases)}`,
          ]
            .filter((line) => line.length > 0)
            .join('\n\n'),
        },
      ],
      output_config: { format: zodOutputFormat(AssessmentSchema) },
    });

    if (response.parsed_output === null) {
      throw new Error('question engine returned no parsable assessment');
    }
    return response.parsed_output;
  }

  private async fileDraft(
    params: {
      template: MarketTemplate;
      creatorId: string;
      isFirstMarket: boolean;
      activationPath?: 'organic' | 'seeded';
    },
    problems: TemplateProblem[],
    assessment: (Assessment & { balanced: boolean }) | null,
    state: 'suggested' | 'rejected',
  ) {
    // §2.9: "First-time creators always route to human review."
    const finalState = params.isFirstMarket && state === 'suggested' ? 'suggested' : state;

    if (params.isFirstMarket) {
      logger.info(
        { creatorId: params.creatorId },
        'first market from this creator — routed to human review regardless of score',
      );
    }

    return this.prisma.marketDraft.create({
      data: {
        source: 'community',
        templateJson: JSON.parse(JSON.stringify(params.template)) as object,
        balanceEstimate: assessment === null ? 0 : Math.max(...assessment.balanceEstimates),
        engagementScore: assessment?.engagementScore ?? 0,
        blocklistFlags: {
          problems: problems.map((p) => ({ code: p.code, message: p.message })),
          concerns: assessment?.concerns ?? [],
          balanced: assessment?.balanced ?? false,
          influenceable: assessment?.influenceable ?? false,
          duplicate: assessment?.duplicateOfLiveMarket ?? false,
          reason: assessment?.reason ?? problems.map((p) => p.message).join(' '),
          firstMarket: params.isFirstMarket,
          // Approval happens later and needs to know whose market this is, and
          // which activation path the creator picked (§2.4 — "the creator
          // chooses at creation", so it cannot be decided by the reviewer).
          creatorId: params.creatorId,
          activationPath: params.activationPath ?? 'organic',
        },
        state: finalState,
      },
    });
  }
}
