import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import { env } from '../config/env';
import {
  ReadingSchema,
  type Reading,
  type ResolutionAnalyst,
  type ResolutionRequest,
} from './resolution-analyst';

const MODEL = 'claude-opus-5';

/**
 * The prompt, and its one unusual instruction: refusing to answer is a good
 * answer.
 *
 * A model asked "which outcome?" will produce one. That is exactly wrong here.
 * The cases this exists to handle well are the ones where the source published
 * nothing, or published something ambiguous, or two sources disagree — and in
 * every one of them a confident guess is worse than silence, because a staff
 * member reading a dossier is reading it precisely because they want a second
 * opinion on a hard call.
 */
const SYSTEM = `You read published evidence and say what it shows. You do not settle markets — a staff member proposes the result, a second staff member confirms it, and a 48-hour dispute window runs before anybody is paid. Your reading is one input to the first of those people.

Rules:
1. Only the named resolution source settles the question. Reputable news can corroborate, add context or contradict — it can never be the reason. If the resolution source has published nothing usable, say so and recommend a void review.
2. Never reconcile disagreeing sources. If two say different things, list both claims against the fact they disagree about. An average of two published figures is a number nobody published.
3. Confidence is about the evidence, not about your fluency. A single clear publication from the named source is high confidence. An inference from surrounding coverage is low, however obvious it feels.
4. Recommend a void review rather than guess when: the named source is silent, the publication is ambiguous against the market's own criteria, the edge cases cover what happened, or sources conflict on the deciding fact.
5. Cite every source by name in the reasoning. A staff member has to be able to check you in a minute, from the page.

Write plainly. Do not hedge and do not flatter the evidence.`;

/** The Anthropic reader. Null when no key is configured, so callers fail closed. */
export class AnthropicAnalyst implements ResolutionAnalyst {
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  static create(): AnthropicAnalyst | null {
    return env.ANTHROPIC_API_KEY === undefined ? null : new AnthropicAnalyst();
  }

  async read(request: ResolutionRequest): Promise<Reading> {
    const response = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      system: SYSTEM,
      messages: [{ role: 'user', content: describe(request) }],
      output_config: { format: zodOutputFormat(ReadingSchema) },
    });

    if (response.parsed_output === null) {
      throw new Error('the analyst returned nothing parsable');
    }
    return response.parsed_output;
  }
}

/** The market and its evidence, as plain text the model reads top to bottom. */
function describe(request: ResolutionRequest): string {
  const criteria = Object.entries(request.criteria)
    .map(([label, rule]) => `  ${label}: ${rule}`)
    .join('\n');
  const edges = Object.entries(request.edgeCases)
    .map(([situation, effect]) => `  ${situation}: ${effect}`)
    .join('\n');

  // Tier first, then recency. The model should meet the source that settles
  // the question before it meets forty outlets reporting on it.
  const ordered = [...request.evidence].sort(
    (a, b) =>
      rank(a.tier) - rank(b.tier) ||
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );

  const evidence =
    ordered.length === 0
      ? '  (nothing has been collected for this market)'
      : ordered
          .map(
            (item) =>
              `  [${item.tier}] ${item.sourceName} — ${item.headline}\n` +
              `    ${item.url}\n` +
              `    published ${item.publishedAt}${
                item.clusterSize > 1 ? `, carried by ${item.clusterSize} outlets` : ''
              }\n` +
              `    facts: ${JSON.stringify(item.facts)}`,
          )
          .join('\n\n');

  return [
    `Question: ${request.question}`,
    `Resolution source: ${request.sourceName} — ${request.sourceUrl}`,
    `Event date: ${request.eventDate}`,
    `Now: ${request.now.toISOString()}`,
    `Outcomes: ${request.outcomes.join(' | ')}`,
    `Settlement criteria:\n${criteria}`,
    `Edge cases:\n${edges}`,
    `Evidence collected:\n${evidence}`,
  ].join('\n\n');
}

function rank(tier: EvidenceTier): number {
  return tier === 'resolution' ? 0 : tier === 'news' ? 1 : 2;
}

type EvidenceTier = 'resolution' | 'news' | 'signal';
