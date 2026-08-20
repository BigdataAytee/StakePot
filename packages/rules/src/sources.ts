/**
 * Which sources may say what.
 *
 * The checklist's rule 1 asks for "one named official source" and rule 17 for
 * an outcome nobody can settle without one. A registry of thousands of feeds
 * only satisfies those rules if the registry itself knows the difference
 * between a body that settles a market and a newspaper that reports on it —
 * so the tiers are policy, and they live here beside the rules they serve
 * rather than as a column somebody can widen in an admin form.
 *
 * The distinction is not about quality. A national broadsheet may be more
 * accurate than a ministry's website and still belong in tier 2, because the
 * question "what will the CBN publish" is settled by the CBN and by nobody
 * else. Tier is about authority over the specific fact a market turns on.
 */

export type SourceTier = 'resolution' | 'news' | 'signal';

export interface TierPolicy {
  /** May be named on a market and cited in a resolution dossier. */
  readonly settles: boolean;
  /** May be shown to a trader, with attribution and a link. */
  readonly public: boolean;
  /** Where the trust score starts for a newly added source. */
  readonly initialTrust: number;
  readonly description: string;
}

export const TIERS: Readonly<Record<SourceTier, TierPolicy>> = {
  /**
   * Tier 1. Small and curated — the bodies whose publication *is* the fact.
   * CBN, NBS, NNPC/NMDPRA, INEC and the state electoral bodies, CAF, FIFA,
   * the NPFL, exchange and company registries.
   */
  resolution: {
    settles: true,
    public: true,
    initialTrust: 1,
    description: 'Settles markets. The only tier a market may name or a dossier may cite.',
  },
  /**
   * Tier 2. Reputable news, at scale. Context, early signal, and the "why did
   * the line move" a trader is owed — never authority over the result.
   */
  news: {
    settles: false,
    public: true,
    initialTrust: 0.6,
    description: 'Context and early signal. Never resolution authority.',
  },
  /**
   * Tier 3. Forecast markets, poll aggregators, sports data, analyst
   * consensus. Useful for pitching a threshold at consensus (rule 7) and
   * never shown to a trader: a platform that publishes somebody else's odds
   * beside its own price is telling its users what to think.
   */
  signal: {
    settles: false,
    public: false,
    initialTrust: 0.4,
    description: 'Staff-side only. Informs thresholds; never surfaced to users.',
  },
};

/** Whether an item from this tier may appear on a public screen. */
export function isPublicTier(tier: SourceTier): boolean {
  return TIERS[tier].public;
}

/**
 * Whether this source may be named on a market or cited in a dossier.
 *
 * A single function rather than a check spelled out at each call site: the
 * market wizard, the dossier assembler and the resolution endpoint all have to
 * agree, and "tier === 'resolution'" written in three places is three places
 * for a fourth tier to be forgotten.
 */
export function maySettle(tier: SourceTier): boolean {
  return TIERS[tier].settles;
}

/** How much a source's trust moves when it is caught disagreeing with tier 1. */
export const CONFLICT_PENALTY = 0.15;

/** And how much it recovers per corroborated week, so one bad week is not fatal. */
export const CONFLICT_RECOVERY = 0.05;

/** Below this, a tier-2 source stops being shown and waits for a human. */
export const DEMOTION_FLOOR = 0.25;

export interface SourceRecord {
  readonly tier: SourceTier;
  readonly trust: number;
  /** Times this source has been caught contradicting a tier-1 fact. */
  readonly conflicts: number;
  /** Times it has agreed with one since the last conflict. */
  readonly corroborations: number;
}

export interface TrustVerdict {
  readonly trust: number;
  /** True when the source should stop being surfaced until somebody looks. */
  readonly demoted: boolean;
  readonly reason: string;
}

/**
 * What a source's trust should be, given its record.
 *
 * Pure, and computed from the whole record rather than mutated on each event.
 * A score that is incremented in place cannot be recomputed after a bug, and
 * the first thing anybody asks about an automatic demotion is "why" — which
 * needs the arithmetic to be reproducible from the rows, not from a history of
 * updates nobody kept.
 *
 * Tier 1 never demotes. A source that settles markets disagreeing with itself
 * is not a trust problem to be scored down quietly; it is an incident, and it
 * belongs in front of a person rather than in a decayed number.
 */
export function trustOf(record: SourceRecord): TrustVerdict {
  if (record.tier === 'resolution') {
    return {
      trust: TIERS.resolution.initialTrust,
      demoted: false,
      reason:
        record.conflicts > 0
          ? 'A resolution source contradicting itself is an incident, not a score. Left at full trust and flagged for a person.'
          : 'Resolution source.',
    };
  }

  const base = TIERS[record.tier].initialTrust;
  const trust = clamp(
    base - record.conflicts * CONFLICT_PENALTY + record.corroborations * CONFLICT_RECOVERY,
    0,
    base,
  );

  if (trust < DEMOTION_FLOOR) {
    return {
      trust,
      demoted: true,
      reason: `Contradicted a resolution source ${record.conflicts} time${
        record.conflicts === 1 ? '' : 's'
      }. Held back until somebody reviews it.`,
    };
  }
  return { trust, demoted: false, reason: 'Within tolerance.' };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * How often to re-read a source, given how close its markets are to settling.
 *
 * Minutes near settlement, hourly the rest of the time. The cadence is a
 * function rather than a column because it depends on the *markets*, not on
 * the source: the same CBN page is worth reading every two minutes on the
 * afternoon a rate decision lands and once an hour for the fortnight before.
 */
export function crawlIntervalMs(hoursToNearestSettlement: number | null): number {
  if (hoursToNearestSettlement === null) return 6 * 3_600_000;
  if (hoursToNearestSettlement <= 1) return 2 * 60_000;
  if (hoursToNearestSettlement <= 6) return 10 * 60_000;
  if (hoursToNearestSettlement <= 48) return 30 * 60_000;
  return 3_600_000;
}
