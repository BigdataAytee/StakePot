/**
 * §6.5's abuse queue, as rules.
 *
 * "Abuse queue: wash-trading flags, stake-flood alerts, multi-account clusters,
 * each with evidence + freeze/clear."
 *
 * The phrase that shapes all of this is **"each with evidence"**. A flag that
 * says "this account looks suspicious" is a flag a reviewer cannot act on and
 * cannot defend if the account complains. So every rule here returns the
 * numbers it fired on, and the reviewer sees the same arithmetic the detector
 * did.
 *
 * Nothing here freezes anybody. Detection proposes; a person in Trust & Safety
 * decides (§6.5) — the same shape as §2.15e's moderation and §2.9's drafts
 * queue, and for the same reason: an automated rule that can act alone will
 * eventually act wrongly on somebody with no way to argue.
 */

export type FlagKind = 'wash_trading' | 'stake_flood' | 'multi_account';

export interface AbuseFlag {
  readonly kind: FlagKind;
  readonly userId: string;
  /** 0–1. How confident the rule is, so a queue can be ordered by it. */
  readonly severity: number;
  /** One sentence a reviewer reads first. */
  readonly summary: string;
  /** The numbers it fired on. A flag without these is not reviewable. */
  readonly evidence: Record<string, string | number>;
}

export interface AbuseRules {
  /** Buy-then-sell round trips within this window count as one wash cycle. */
  readonly washWindowMinutes: number;
  /** Round trips in a market before it looks like churn rather than a change of mind. */
  readonly washCycles: number;
  /** Trades in an hour above which a human is unlikely to be typing. */
  readonly floodTradesPerHour: number;
  /** Accounts sharing a fingerprint above which it stops looking like a household. */
  readonly clusterAccounts: number;
}

export const DEFAULT_ABUSE_RULES: AbuseRules = {
  washWindowMinutes: 30,
  washCycles: 4,
  floodTradesPerHour: 120,
  clusterAccounts: 4,
};

/** One person's trades on one market, in time order. */
export interface TradeRow {
  readonly userId: string;
  readonly marketId: string;
  readonly side: 'buy' | 'sell' | 'seed';
  readonly cost: number;
  readonly at: Date;
}

/**
 * Wash trading: buying and selling the same market back and forth.
 *
 * On an LMSR book this is not free — every round trip pays the exit fee — so a
 * few cycles are somebody changing their mind expensively, not an attack. What
 * the rule looks for is a *pattern*: repeated round trips inside a short window,
 * which on a points platform is how somebody inflates volume for a leaderboard
 * or a creator fee rather than how anybody expresses a view.
 */
export function washTrading(trades: readonly TradeRow[], rules: AbuseRules): readonly AbuseFlag[] {
  const byUserMarket = new Map<string, TradeRow[]>();
  for (const trade of trades) {
    if (trade.side === 'seed') continue;
    const key = `${trade.userId}:${trade.marketId}`;
    byUserMarket.set(key, [...(byUserMarket.get(key) ?? []), trade]);
  }

  const flags: AbuseFlag[] = [];
  for (const [key, rows] of byUserMarket) {
    const ordered = [...rows].sort((left, right) => left.at.getTime() - right.at.getTime());

    let cycles = 0;
    let volume = 0;
    let openedAt: Date | null = null;

    for (const trade of ordered) {
      volume += Math.abs(trade.cost);
      if (trade.side === 'buy' && openedAt === null) {
        openedAt = trade.at;
        continue;
      }
      if (trade.side === 'sell' && openedAt !== null) {
        const minutes = (trade.at.getTime() - openedAt.getTime()) / 60_000;
        if (minutes <= rules.washWindowMinutes) cycles += 1;
        openedAt = null;
      }
    }

    if (cycles < rules.washCycles) continue;

    const [userId, marketId] = key.split(':');
    flags.push({
      kind: 'wash_trading',
      userId: userId ?? '',
      severity: Math.min(1, cycles / (rules.washCycles * 2)),
      summary: `${cycles} buy-and-sell round trips on one market inside ${rules.washWindowMinutes} minutes each.`,
      evidence: {
        marketId: marketId ?? '',
        roundTrips: cycles,
        windowMinutes: rules.washWindowMinutes,
        volume: Math.round(volume),
        trades: ordered.length,
      },
    });
  }
  return flags;
}

/**
 * Stake floods: more trades in an hour than a person places by hand.
 *
 * Deliberately counts trades rather than money. A large stake is somebody
 * confident; four hundred small ones in an hour is a script, and it is the
 * script that costs the platform — in queue depth, in price noise, and in the
 * per-market ordering §11 has to maintain.
 */
export function stakeFlood(trades: readonly TradeRow[], rules: AbuseRules): readonly AbuseFlag[] {
  const byUser = new Map<string, TradeRow[]>();
  for (const trade of trades) {
    if (trade.side === 'seed') continue;
    byUser.set(trade.userId, [...(byUser.get(trade.userId) ?? []), trade]);
  }

  const flags: AbuseFlag[] = [];
  for (const [userId, rows] of byUser) {
    const ordered = [...rows].sort((left, right) => left.at.getTime() - right.at.getTime());

    // The busiest sliding hour, not the calendar hour: an account placing 119
    // trades either side of the hour boundary is the pattern the rule is for.
    let worst = 0;
    let start = 0;
    for (let end = 0; end < ordered.length; end += 1) {
      while (ordered[end]!.at.getTime() - ordered[start]!.at.getTime() > 3_600_000 && start < end) {
        start += 1;
      }
      worst = Math.max(worst, end - start + 1);
    }

    if (worst < rules.floodTradesPerHour) continue;

    flags.push({
      kind: 'stake_flood',
      userId,
      severity: Math.min(1, worst / (rules.floodTradesPerHour * 2)),
      summary: `${worst} trades inside one hour — faster than a person places by hand.`,
      evidence: {
        peakTradesPerHour: worst,
        threshold: rules.floodTradesPerHour,
        totalTrades: ordered.length,
        markets: new Set(ordered.map((trade) => trade.marketId)).size,
      },
    });
  }
  return flags;
}

/** An account and the device it signed up from (§2.1's farm-detection signal). */
export interface AccountRow {
  readonly userId: string;
  readonly fingerprint: string | null;
  readonly tier: number;
  readonly createdAt: Date;
}

/**
 * Multi-account clusters: several accounts behind one device.
 *
 * §2.1 calls this "the anti-farming/anti-multi-account gate" and §2.7 asks for
 * "device fingerprint flagging for farm detection". Two accounts on one phone
 * is a household; six Tier 0 accounts created the same afternoon is a farm
 * collecting starter balances.
 *
 * The rule weights *unverified* accounts, because that is what the farm is made
 * of — a cluster of Tier 1 accounts has already paid the cost of a verified
 * contact each, which is the gate doing its job.
 */
export function multiAccount(
  accounts: readonly AccountRow[],
  rules: AbuseRules,
): readonly AbuseFlag[] {
  const byFingerprint = new Map<string, AccountRow[]>();
  for (const account of accounts) {
    if (account.fingerprint === null || account.fingerprint.length === 0) continue;
    byFingerprint.set(account.fingerprint, [
      ...(byFingerprint.get(account.fingerprint) ?? []),
      account,
    ]);
  }

  const flags: AbuseFlag[] = [];
  for (const [fingerprint, group] of byFingerprint) {
    if (group.length < rules.clusterAccounts) continue;

    const unverified = group.filter((account) => account.tier < 1).length;
    const ordered = [...group].sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    );
    const spanHours =
      (ordered[ordered.length - 1]!.createdAt.getTime() - ordered[0]!.createdAt.getTime()) /
      3_600_000;

    // The whole cluster is flagged, one row each, so a reviewer can clear the
    // household member who is genuinely separate without clearing the farm.
    for (const account of group) {
      flags.push({
        kind: 'multi_account',
        userId: account.userId,
        severity: Math.min(
          1,
          (unverified / group.length) * (group.length / (rules.clusterAccounts * 2)),
        ),
        summary: `${group.length} accounts share one device, ${unverified} of them unverified.`,
        evidence: {
          fingerprint,
          accounts: group.length,
          unverified,
          createdWithinHours: Math.round(spanHours * 10) / 10,
          others: group
            .filter((other) => other.userId !== account.userId)
            .map((other) => other.userId)
            .join(', '),
        },
      });
    }
  }
  return flags;
}

/** Every rule, most severe first. */
export function detect(
  input: { trades: readonly TradeRow[]; accounts: readonly AccountRow[] },
  rules: AbuseRules,
): readonly AbuseFlag[] {
  return [
    ...washTrading(input.trades, rules),
    ...stakeFlood(input.trades, rules),
    ...multiAccount(input.accounts, rules),
  ].sort((left, right) => right.severity - left.severity);
}
