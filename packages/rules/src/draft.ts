/**
 * What a market looks like before it is a market, and what the reviewer knows
 * about the shelf it is about to join.
 *
 * Split from the validators so the AI, the admin wizard and the community
 * wizard all describe a draft the same way. They arrive at one from different
 * directions — generated, typed, or assembled from a template — and the whole
 * point of this package is that what happens next does not depend on which.
 */

export interface DraftOutcome {
  readonly label: string;
  /** Exactly what makes this the result, according to the named source. */
  readonly criteria: string;
}

export interface TicketDraft {
  readonly question: string;
  readonly outcomes: readonly DraftOutcome[];
  /** Rule 3's catch-all, on a market whose field is open. */
  readonly otherLabel?: string | undefined;
  readonly sourceName: string;
  readonly sourceUrl: string;
  /**
   * ISO 8601. Rule 26 wants an hour, so a date-only string is a failure rather
   * than something to default — see the rule 26 check for why that matters.
   */
  readonly eventDate: string;
  readonly voidDate: string;
  /** Situation → how it settles. Rule 4. */
  readonly edgeCases: Readonly<Record<string, string>>;
  /** Rule 6. Probability per outcome, in order. */
  readonly balanceEstimates?: readonly number[] | undefined;
  /** Rule 22. Defaults to the event date, which is what the rule asks for. */
  readonly freezesAt?: string | undefined;
  /** Rule 24. */
  readonly liquidityParam?: string | number | undefined;
  readonly expectedStake?: string | number | undefined;
  /** Rule 30. */
  readonly category?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly icon?: string | undefined;
  /** Rule 10's exception: an election or a tournament may run long. */
  readonly blockbuster?: boolean | undefined;
}

/**
 * Everything the checklist asks about that is not in the draft itself.
 *
 * Each field is optional, and absence is treated as "not known" rather than
 * "fine". A review that reports a clean pass on the duplicate rule because
 * nobody looked for duplicates is exactly the failure this package exists to
 * prevent — so an unsupplied fact produces a `note`, which is visible, rather
 * than a `pass`, which is a claim.
 */
export interface ReviewContext {
  readonly now: Date;
  /** Rule 21. Live markets close enough to split this one's liquidity. */
  readonly duplicates?: readonly { readonly id: string; readonly question: string }[] | undefined;
  /** Rule 33. How many live markets already settle on this market's day. */
  readonly settlingSameDay?: number | undefined;
  /** Rule 34. How many markets are live, against how many the shelf wants. */
  readonly liveCount?: number | undefined;
  readonly catalogueSlots?: number | undefined;
  /** Rule 32. The same market from the previous cycle, for a recurring series. */
  readonly previousCycle?: { readonly question: string } | undefined;
  /** Rule 8. Whether news is expected between opening and settlement. */
  readonly expectedNewsFlow?: boolean | undefined;
  /** Rules 5 and 16. The creator's attestation, recorded against the submission. */
  readonly attestedNoInfluence?: boolean | undefined;
  /**
   * Answers to the rules only a person can settle, keyed by rule id. Absent
   * means unanswered, which blocks — an unasked question is not a pass.
   */
  readonly confirmations?: Readonly<Record<string, boolean>> | undefined;
}
