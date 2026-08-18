/**
 * §2.14c's progression ladder, as rules rather than as a table in a document.
 *
 * "Status is the points-phase currency." Before there is naira to earn, the
 * only thing the platform can pay a creator is standing — so standing has to
 * mean something, which means it has to be earned from the record and lost
 * with it. Everything here is a pure function of a creator's counters, so the
 * ladder is testable without a database and cannot drift between the screen
 * that shows a level and the code that grants its privileges.
 *
 * The bracketed numbers in §2.14c are tunables. They arrive as `LadderRules`
 * from `platform_config`; nothing here hard-codes a threshold.
 */

export type CreatorLevel = 1 | 2 | 3;

/** What a creator's record actually says. Counted, never asserted. */
export interface CreatorRecord {
  /** Markets that settled with no dispute upheld against the creator. */
  readonly cleanResolutions: number;
  /** Markets that settled with a dispute upheld — the creator got it wrong. */
  readonly disputedResolutions: number;
  /**
   * Markets that voided *after* activation. A Path A market that never filled
   * is not misconduct — nobody turned up — so it is not counted here.
   */
  readonly voidedAfterActivation: number;
  /** Total staked across every market they have hosted, in SPC. */
  readonly volumeHosted: number;
}

export interface LadderRules {
  readonly level2CleanResolutions: number;
  readonly level3CleanResolutions: number;
  readonly level3VolumeSpc: number;
  /** The share of settled markets that must be clean to reach level 3. */
  readonly level3CleanRate: number;
  readonly maxLiveMarkets: Readonly<Record<CreatorLevel, number>>;
  /** Multiplier on `conduct_bond_spc`. Level 2's "reduced bond" (§2.14c). */
  readonly bondMultiplier: Readonly<Record<CreatorLevel, number>>;
  /** Level 3's fee bump: the creator's share of the community fee, in bps. */
  readonly creatorBps: Readonly<Record<CreatorLevel, number>>;
  /**
   * Whether a level can be lost. Privileges tied to a record should track the
   * record — a Pro creator whose resolutions stop being clean keeps featured
   * placement and a fee bump otherwise — but demotion is a policy call, so it
   * is one config flip rather than a code change.
   */
  readonly demotionEnabled: boolean;
}

/** Everything a level grants. Read by the code that enforces it, not by a screen. */
export interface Privileges {
  readonly level: CreatorLevel;
  readonly maxLiveMarkets: number;
  readonly bondMultiplier: number;
  readonly creatorBps: number;
  /** §2.14c level 2: "auto-approval on template-standard markets". */
  readonly autoApproveTemplateStandard: boolean;
  readonly featuredPlacement: boolean;
  readonly customSyndicateSplits: boolean;
  readonly bonusPoolShare: boolean;
  readonly badge: string | null;
}

export const LEVEL_NAMES: Readonly<Record<CreatorLevel, string>> = {
  1: 'New',
  2: 'Verified',
  3: 'Pro',
};

/** Settled markets — the denominator the clean rate is measured against. */
export function settledCount(record: CreatorRecord): number {
  return record.cleanResolutions + record.disputedResolutions + record.voidedAfterActivation;
}

/**
 * The share of a creator's settled markets that ended clean.
 *
 * A creator with no settled markets has no rate, not a perfect one — returning
 * 1 here would hand a brand-new account the cleanest record on the platform.
 */
export function cleanRate(record: CreatorRecord): number | null {
  const settled = settledCount(record);
  return settled === 0 ? null : record.cleanResolutions / settled;
}

/** The level the record earns, ignoring whatever level is currently stored. */
export function earnedLevel(record: CreatorRecord, rules: LadderRules): CreatorLevel {
  const rate = cleanRate(record);
  if (
    record.cleanResolutions >= rules.level3CleanResolutions &&
    record.volumeHosted >= rules.level3VolumeSpc &&
    rate !== null &&
    rate >= rules.level3CleanRate
  ) {
    return 3;
  }
  if (record.cleanResolutions >= rules.level2CleanResolutions) return 2;
  return 1;
}

/**
 * The level a creator should now hold, given what they hold today.
 *
 * With demotion off this only ever ratchets up, which is the kinder reading of
 * "status is the currency"; with it on, the level is a live statement about the
 * record rather than a trophy for having once had one.
 */
export function nextLevel(
  current: CreatorLevel,
  record: CreatorRecord,
  rules: LadderRules,
): CreatorLevel {
  const earned = earnedLevel(record, rules);
  if (rules.demotionEnabled) return earned;
  return earned > current ? earned : current;
}

export function privilegesFor(level: CreatorLevel, rules: LadderRules): Privileges {
  return {
    level,
    maxLiveMarkets: rules.maxLiveMarkets[level],
    bondMultiplier: rules.bondMultiplier[level],
    creatorBps: rules.creatorBps[level],
    autoApproveTemplateStandard: level >= 2,
    featuredPlacement: level >= 3,
    customSyndicateSplits: level >= 3,
    bonusPoolShare: level >= 3,
    badge: level === 1 ? null : LEVEL_NAMES[level],
  };
}

/**
 * What is still missing before the next level — the text the creator studio
 * shows, computed here so the screen cannot invent an easier ladder.
 *
 * Returns null at level 3: there is nothing above Pro.
 */
export function progressToNext(
  record: CreatorRecord,
  rules: LadderRules,
): { readonly target: CreatorLevel; readonly requirements: readonly Requirement[] } | null {
  const level = earnedLevel(record, rules);
  if (level === 3) return null;

  if (level === 1) {
    return {
      target: 2,
      requirements: [
        {
          label: 'clean resolutions',
          have: record.cleanResolutions,
          need: rules.level2CleanResolutions,
          met: record.cleanResolutions >= rules.level2CleanResolutions,
        },
      ],
    };
  }

  const rate = cleanRate(record);
  return {
    target: 3,
    requirements: [
      {
        label: 'clean resolutions',
        have: record.cleanResolutions,
        need: rules.level3CleanResolutions,
        met: record.cleanResolutions >= rules.level3CleanResolutions,
      },
      {
        label: 'volume hosted',
        have: record.volumeHosted,
        need: rules.level3VolumeSpc,
        met: record.volumeHosted >= rules.level3VolumeSpc,
      },
      {
        label: 'clean rate',
        have: rate ?? 0,
        need: rules.level3CleanRate,
        met: rate !== null && rate >= rules.level3CleanRate,
      },
    ],
  };
}

export interface Requirement {
  readonly label: string;
  readonly have: number;
  readonly need: number;
  readonly met: boolean;
}
