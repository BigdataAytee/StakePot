import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

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

/** The house style, shared by every mode. §2.9's prime directive comes first. */
const HOUSE = `You work on StakeAm, a Nigerian prediction market.

Your prime directive is genuine disagreement: a good market is one the audience splits close to 50/50 on. An obvious answer produces a dead market and negligible fees, so treat a lopsided estimate as a real problem, not a quibble.

Never touch questions about death, injury, illness, crime, violence, security incidents, private individuals, anything a participant could influence, or an outcome with no checkable public source.

Write in plain Nigerian English. Be specific. Do not apologise.`;

const SCREENING_SYSTEM = `${HOUSE}

You are screening a submission somebody else wrote. Judge it on:
1. Balance — estimate the probability of each outcome honestly, in the order given. Do not flatter the submission.
2. Structure — a definite conclusion by a stated date, outcomes that are complete, and exactly one named official source that can settle every one of them.
3. Influence — reject anything a participant or the creator could affect, or would have inside knowledge of.
4. Engagement — Nigerian mass interest: the naira and cost of living, football, elections, BBNaija and entertainment, fuel.
5. Duplication — whether this restates a market already trading.

You advise; a human decides.`;

const GENERATION_SYSTEM = `${HOUSE}

You are drafting a question for one slot on the official shelf. Rules, all mandatory:
1. Emit the complete template — question, every outcome with its settlement criteria, one named source with a URL, event date, void date, and edge cases. A question without them is not a suggestion.
2. For anything numeric — inflation, FX, fuel — set the threshold at the current consensus or market forecast, never at a level with an obvious answer. Say what consensus you are pitching against in the rationale.
3. Estimate the probabilities honestly. If your own estimate is lopsided, propose a different threshold or a different question rather than a market nobody will argue about.
4. The outcome must be settled by exactly one named public source, by a stated date, with no participant able to influence it, and with news likely between opening and settlement.
5. Prefer a multi-outcome list to Yes/No wherever the story allows ("who wins X?") — it is naturally closer to balanced and pulls in more than one fanbase. Add an "Any other" bucket when the field is genuinely open.
6. Suggest a replacement for the slot you are given, not an addition to the shelf.`;

const COPILOT_SYSTEM = `${HOUSE}

Somebody has typed a question the way they would say it out loud. Turn it into a complete market template without changing what they meant: the question in one clean sentence, every outcome with its settlement criteria, one named official source with a URL, event and void dates, and the edge cases that would otherwise cause an argument.

Where the field is open, list the real contenders and add an "Any other" bucket. If their idea cannot be settled by a public source, or has an obvious answer, say so in the rationale rather than inventing a source or a threshold.

Estimate the probabilities honestly — the creator is about to be shown them, and a flattering estimate costs them money.`;

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
