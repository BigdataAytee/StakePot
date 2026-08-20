import { z } from 'zod';

/**
 * The seam between the resolution rules and the model that reads the evidence.
 *
 * The same shape as §2.9's question model, for the same reason: every decision
 * belongs to code that can be tested without an API key, and the only thing
 * that has to be *asked* is the judgement — given these published facts, which
 * outcome do they point at, and how sure can anybody be.
 *
 * What this interface deliberately cannot express is a settlement. It returns
 * a reading of evidence. Nothing downstream of it may write a resolution: that
 * path takes a staff id, and a second staff id to confirm.
 */

/** One thing a source published, as the analyst sees it. */
export interface EvidenceItem {
  readonly sourceName: string;
  readonly tier: 'resolution' | 'news' | 'signal';
  readonly headline: string;
  readonly url: string;
  readonly publishedAt: string;
  /** Figures, scores, statements pulled out of it. */
  readonly facts: Readonly<Record<string, string | number>>;
  /** How many outlets carried the same story. 1 for a tier-1 publication. */
  readonly clusterSize: number;
}

export const ReadingSchema = z.object({
  /**
   * The label of the outcome the evidence points at, exactly as listed.
   * Null when the evidence does not point anywhere.
   */
  outcomeLabel: z
    .string()
    .nullable()
    .describe('The outcome label the named source’s publication settles to, or null.'),
  confidence: z
    .number()
    .describe('0-1. How firmly the named resolution source alone settles this.'),
  /**
   * The reasoning, citing sources by name. This is what a staff member reads
   * before they decide, so it is the product — not a rationalisation attached
   * to an answer.
   */
  reasoning: z.string().describe('Two to five sentences, citing each source by name.'),
  /** Facts the sources disagree about, rather than an average of them. */
  conflicts: z
    .array(
      z.object({
        factKey: z.string(),
        claims: z.array(z.object({ sourceName: z.string(), claim: z.string() })),
      }),
    )
    .describe('Where sources disagree. Never reconcile them yourself.'),
  /** True when the honest recommendation is to review for a void. */
  recommendVoid: z
    .boolean()
    .describe('True if the resolution source published nothing usable, or sources conflict.'),
  voidReason: z.string().describe('Why, when recommending a void. Empty otherwise.'),
});

export type Reading = z.infer<typeof ReadingSchema>;

export interface ResolutionRequest {
  readonly question: string;
  readonly criteria: Readonly<Record<string, string>>;
  readonly edgeCases: Readonly<Record<string, string>>;
  readonly outcomes: readonly string[];
  readonly sourceName: string;
  readonly sourceUrl: string;
  readonly eventDate: string;
  readonly evidence: readonly EvidenceItem[];
  readonly now: Date;
}

export interface ResolutionAnalyst {
  read(request: ResolutionRequest): Promise<Reading>;
}

export const RESOLUTION_ANALYST = Symbol('stakeam:resolution-analyst');
