import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { CHECKLIST_PROMPT, HARD_CONSTRAINTS, SCORING_CRITERIA } from '@stakeam/rules';

import { env } from '../config/env';
import type { MarketTemplate } from './market-template';
import {
  AssessmentSchema,
  ProposalSchema,
  type Assessment,
  type GenerationRequest,
  type Proposal,
  type QuestionModel,
} from './question-model';

export class QuestionEngineUnavailableError extends Error {
  constructor() {
    super('ANTHROPIC_API_KEY is not configured — the question engine cannot run');
    this.name = 'QuestionEngineUnavailableError';
  }
}

const MODEL = 'claude-opus-5';

/**
 * The house style, shared by every mode.
 *
 * The prohibitions used to be a paragraph written here by hand, beside a rule
 * table in `market-template.ts` that said much the same thing in code. Two
 * copies of a law is one copy plus a bug waiting to be found in production, so
 * the constraints now come out of `@stakeam/rules` — the same register the
 * validators read, rendered for a model instead of for a review screen.
 */
const HOUSE = `You work on StakeAm, a Nigerian prediction market.

Your prime directive is genuine disagreement: a good market is one the audience splits close to 50/50 on. An obvious answer produces a dead market and negligible fees, so treat a lopsided estimate as a real problem, not a quibble.

Every market you touch is governed by StakeAm's ticket-creation checklist. It is not advice.

${HARD_CONSTRAINTS}

Write in plain Nigerian English. Be specific. Do not apologise.`;

const SCREENING_SYSTEM = `${HOUSE}

You are screening a submission somebody else wrote. Judge it on:
1. Balance — estimate the probability of each outcome honestly, in the order given. Do not flatter the submission.
2. Structure — a definite conclusion by a stated date, outcomes that are complete, and exactly one named official source that can settle every one of them.
3. Influence — reject anything a participant or the creator could affect, or would have inside knowledge of.
4. Engagement — Nigerian mass interest: the naira and cost of living, football, elections, BBNaija and entertainment, fuel.
5. Duplication — whether this restates a market already trading.

${SCORING_CRITERIA}

You advise; a human decides. Say what is wrong plainly — a submission waved through because the concerns felt minor costs the creator their bond and the platform a market nobody argues about.`;

const GENERATION_SYSTEM = `${HOUSE}

You are drafting a question for one slot on the official shelf, and you are drafting it to the checklist below rather than to your own taste.

${CHECKLIST_PROMPT}

Two further house rules for this mode:
- For anything numeric — inflation, FX, fuel — say in the rationale what consensus or published forecast you pitched the threshold against. A threshold with no stated reference is a guess wearing a number.
- Suggest a replacement for the slot you are given, not an addition to the shelf.`;

const COPILOT_SYSTEM = `${HOUSE}

Somebody has typed a question the way they would say it out loud. Turn it into a complete market template without changing what they meant: the question in one clean sentence, every outcome with its settlement criteria, one named official source with a URL, event and void dates, and the edge cases that would otherwise cause an argument.

Where the field is open, list the real contenders and add an "Any other" bucket. If their idea cannot be settled by a public source, or has an obvious answer, say so in the rationale rather than inventing a source or a threshold.

Estimate the probabilities honestly — the creator is about to be shown them, and a flattering estimate costs them money.

The result has to satisfy the same checklist a staff draft does. The creator will be shown, rule by rule, what passed and what did not, so a template that quietly skips the timezone or the edge cases wastes their time rather than saving it.

${CHECKLIST_PROMPT}`;

/**
 * The Anthropic implementation of the question model (§2.9's "Implementation:
 * Anthropic API... suggestions written to a `market_drafts` table with scores").
 *
 * Every mode uses structured output — §2.9 rule 1 makes free text invalid — and
 * adaptive thinking, because balance and influence are judgements about the real
 * world rather than pattern matching.
 */
export class AnthropicQuestionModel implements QuestionModel {
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    if (client === undefined && env.ANTHROPIC_API_KEY === undefined) {
      throw new QuestionEngineUnavailableError();
    }
    this.client = client ?? new Anthropic();
  }

  /** Null when no key is configured, so callers can fail closed with a message. */
  static create(): AnthropicQuestionModel | null {
    return env.ANTHROPIC_API_KEY === undefined ? null : new AnthropicQuestionModel();
  }

  async assess(template: MarketTemplate): Promise<Assessment> {
    const response = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: SCREENING_SYSTEM,
      messages: [{ role: 'user', content: describe(template) }],
      output_config: { format: zodOutputFormat(AssessmentSchema) },
    });

    if (response.parsed_output === null) {
      throw new Error('question engine returned no parsable assessment');
    }
    return response.parsed_output;
  }

  async propose(request: GenerationRequest): Promise<Proposal> {
    const response = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: GENERATION_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            `Slot: ${request.slot} — ${request.brief}`,
            `Today is ${request.now.toISOString()}.`,
            request.avoid.length === 0
              ? 'Nothing is live on the shelf yet.'
              : `Already live, do not restate:\n${request.avoid.map((q) => `- ${q}`).join('\n')}`,
            // §2.9's feedback loop: the house style, learned from its own hits.
            (request.exemplars ?? []).length === 0
              ? ''
              : `These ran well — balanced, high volume, no disputes. Match this shape:\n${(
                  request.exemplars ?? []
                )
                  .map(
                    (example) =>
                      `- ${example.question} (settled ${Math.round(example.finalSplit * 100)}/${
                        100 - Math.round(example.finalSplit * 100)
                      }, volume ${example.volume})`,
                  )
                  .join('\n')}`,
            (request.retune ?? []).length === 0
              ? ''
              : `These ran lopsided. If you draft anything in the same series, move the threshold:\n${(
                  request.retune ?? []
                )
                  .map(
                    (example) =>
                      `- ${example.question} (settled ${Math.round(example.finalSplit * 100)}/${
                        100 - Math.round(example.finalSplit * 100)
                      })`,
                  )
                  .join('\n')}`,
            briefing(request),
          ]
            .filter((line) => line.length > 0)
            .join('\n\n'),
        },
      ],
      output_config: { format: zodOutputFormat(ProposalSchema) },
    });

    if (response.parsed_output === null) {
      throw new Error('question engine returned no parsable proposal');
    }
    return response.parsed_output;
  }

  async restructure(input: { text: string; now: Date }): Promise<Proposal> {
    const response = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: COPILOT_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Today is ${input.now.toISOString()}.\n\nWhat they typed:\n${input.text}`,
        },
      ],
      output_config: { format: zodOutputFormat(ProposalSchema) },
    });

    if (response.parsed_output === null) {
      throw new Error('question engine returned no parsable draft');
    }
    return response.parsed_output;
  }
}

/**
 * What the research pipeline read about this slot, as the model sees it.
 *
 * Three sections, because they license three different things. The stories are
 * what a question can be *about* — checklist rule 12 wants expected news flow,
 * and a slot with nine outlets on one story has it. The figures are what a
 * threshold can be set *against*, so the model can pitch at the number rather
 * than guess at it. The disagreements are the warning: where two sources
 * published different numbers, the settlement criteria have to name which one
 * settles, and a question drafted without noticing is a dispute waiting.
 *
 * Silence is stated rather than omitted. A prompt that simply leaves the
 * section out when nothing was read invites the model to fill the gap from
 * memory — which is exactly the failure this whole layer exists to prevent.
 */
function briefing(request: GenerationRequest): string {
  const evidence = request.evidence;
  if (evidence === undefined) return '';

  if (evidence.itemsRead === 0) {
    return [
      `RESEARCH: nothing relevant has been published about this slot in the last ${evidence.windowDays} days that our sources carry.`,
      'Do not invent recent developments. Draft from a scheduled event with a known date, or state in `rejectionReason` that there is nothing to hang a question on.',
    ].join(' ');
  }

  const lines = [
    `RESEARCH — what our sources have actually published in the last ${evidence.windowDays} days (${evidence.itemsRead} items read).`,
    'Ground the question in this. Do not cite anything that is not here.',
  ];

  if (evidence.stories.length > 0) {
    lines.push(
      `Stories:\n${evidence.stories
        .map(
          (story) =>
            `- ${story.headline} (${story.sourceName}, ${story.publishedAt.slice(0, 10)}${
              story.sourceCount > 1 ? `, carried by ${story.sourceCount} outlets` : ''
            })`,
        )
        .join('\n')}`,
    );
  }

  if (evidence.figures.length > 0) {
    lines.push(
      `Figures published:\n${evidence.figures
        .map(
          (figure) =>
            `- ${figure.key}: ${figure.value} (${figure.sourceName}, ${figure.publishedAt.slice(0, 10)})`,
        )
        .join('\n')}`,
    );
  }

  if (evidence.conflicts.length > 0) {
    lines.push(
      `Sources DISAGREE on these. If your question turns on one of them, the criteria must name which source settles it:\n${evidence.conflicts
        .map(
          (conflict) =>
            `- ${conflict.factKey}: ${conflict.claims
              .map((claim) => `${claim.sourceName} says ${String(claim.value)}`)
              .join('; ')}`,
        )
        .join('\n')}`,
    );
  }

  return lines.join('\n\n');
}

function describe(template: MarketTemplate): string {
  const outcomes = template.outcomes
    .map((outcome, index) => `${index + 1}. ${outcome.label} — settles when: ${outcome.criteria}`)
    .join('\n');

  return [
    `Question: ${template.question}`,
    `Outcomes:\n${outcomes}`,
    template.otherLabel === undefined ? '' : `Catch-all bucket: ${template.otherLabel}`,
    `Official source: ${template.sourceName} (${template.sourceUrl})`,
    `Event date: ${template.eventDate}`,
    `Void date: ${template.voidDate}`,
    `Edge cases: ${JSON.stringify(template.edgeCases)}`,
  ]
    .filter((line) => line.length > 0)
    .join('\n\n');
}
