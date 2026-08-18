import { z } from 'zod';

import { CATALOGUE_SLOT_NAMES, type CatalogueSlot } from './draft-ranking';
import type { MarketTemplate } from './market-template';

/**
 * The boundary between §2.9's rules and the model that serves them.
 *
 * The service owns every decision — balance bands, the blocklist, duplicates,
 * catalogue discipline, ranking. This interface is only the part that has to be
 * asked: what might a good question be, and how likely is each outcome. Keeping
 * it a seam means the rules are testable without an API key, and that swapping
 * model or vendor cannot quietly change what the platform will publish.
 */

/** §2.9's assessment of one submission. Structured because free text is not a decision. */
export const AssessmentSchema = z.object({
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

/**
 * §2.9 rule 1: "Every suggestion must emit the full market template... Free-text
 * questions are invalid output." The schema is that rule, enforced at the
 * boundary rather than hoped for in a prompt.
 */
export const ProposalSchema = z.object({
  slot: z
    .enum(CATALOGUE_SLOT_NAMES as [CatalogueSlot, ...CatalogueSlot[]])
    .describe('Which shelf slot this suggestion is for (§2.9 rule 8).'),
  question: z.string().describe('One sentence, ending in a question mark.'),
  outcomes: z
    .array(
      z.object({
        label: z.string(),
        criteria: z.string().describe('Exactly what makes this the result, per the named source.'),
      }),
    )
    .describe('Complete list. Where the field is open, add the catch-all separately.'),
  otherLabel: z.string().optional().describe('The "Any other" bucket, where the field is open.'),
  sourceName: z.string(),
  sourceUrl: z.string(),
  eventDate: z.string().describe('ISO 8601. When the event concludes.'),
  voidDate: z.string().describe('ISO 8601. After this, unsettled means voided.'),
  edgeCases: z
    .record(z.string(), z.string())
    .describe('Situation → how it settles. Postponements, abandonments, ties.'),
  balanceEstimates: z
    .array(z.number())
    .describe('Your honest probability for each outcome, in order. Must sum to 1.'),
  engagementScore: z.number().describe('0-1, Nigerian mass interest.'),
  rationale: z.string().describe('One sentence: why this is worth arguing about now.'),
});

export type Proposal = z.infer<typeof ProposalSchema>;

export interface GenerationRequest {
  readonly slot: CatalogueSlot;
  readonly brief: string;
  /** Questions already live. §2.9 asks for replacements, not restatements. */
  readonly avoid: readonly string[];
  /** Past markets that landed near-balanced with real volume and no disputes. */
  readonly exemplars?: readonly { question: string; finalSplit: number; volume: string }[];
  /** Past markets that ran lopsided — retune the threshold, do not repeat it. */
  readonly retune?: readonly { question: string; finalSplit: number }[];
  readonly now: Date;
}

export interface QuestionModel {
  /** Screening mode: judge a submission that already exists. */
  assess(template: MarketTemplate): Promise<Assessment>;
  /** Generation mode: propose a market for one shelf slot. */
  propose(request: GenerationRequest): Promise<Proposal>;
  /** Co-pilot mode (§2.14a): turn what a creator typed into a full template. */
  restructure(input: { text: string; now: Date }): Promise<Proposal>;
}

/** Everything a proposal carries that is not part of the template itself. */
export function templateOf(proposal: Proposal): MarketTemplate {
  return {
    question: proposal.question,
    outcomes: proposal.outcomes,
    ...(proposal.otherLabel === undefined ? {} : { otherLabel: proposal.otherLabel }),
    sourceName: proposal.sourceName,
    sourceUrl: proposal.sourceUrl,
    eventDate: proposal.eventDate,
    voidDate: proposal.voidDate,
    edgeCases: proposal.edgeCases,
  };
}
