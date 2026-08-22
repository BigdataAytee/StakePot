'use client';

import { useEffect, useState } from 'react';

import { authed, getToken } from './session';

/**
 * What this account may stake, read before they type rather than after they
 * commit.
 *
 * §7.2d asks for the Tier 0 cap and §2.12's limits to be surfaced *in the
 * sheet*. The point is the ordering: both are enforced on the trade path, so
 * without this the first time somebody learns they are over a limit is when
 * the trade they just confirmed comes back refused. That is the wrong moment
 * to find out, and on a slow connection it is the wrong moment by several
 * seconds.
 *
 * The figures come from `GET /account/trade-allowance`, which computes them
 * from the same rule the trade path uses — so the warning and the refusal can
 * never disagree.
 */
export interface TradeAllowance {
  tier: number;
  escrowed: string;
  /** Null when uncapped: a verified account, or no cap configured. */
  tierCapRemaining: string | null;
  selfExcluded: boolean;
  cooloffUntil: string | null;
  stakeLimit: string;
  stakedToday: string;
  lossLimit: string;
  lostToday: string;
  helpline: string;
}

export function useTradeAllowance(refreshKey = 0): TradeAllowance | null {
  const [allowance, setAllowance] = useState<TradeAllowance | null>(null);

  useEffect(() => {
    // Signed out has no allowance to report — the sheet already tells them to
    // sign in, and an unauthenticated call would just 401 on every open.
    if (getToken() === null) {
      setAllowance(null);
      return undefined;
    }

    let cancelled = false;
    void authed<TradeAllowance>('/account/trade-allowance')
      .then((found) => {
        if (!cancelled) setAllowance(found);
      })
      // A failed read must never block trading: the server enforces all of this
      // anyway, so the worst case is that we are back to the old behaviour of
      // finding out on submit.
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return allowance;
}

export interface Blocker {
  /** Shown in the sheet, above the button. */
  message: string;
  /** True when no amount will work — the button is disabled outright. */
  hard: boolean;
}

/**
 * What, if anything, stands between this account and staking `amount`.
 *
 * Returns the *binding* constraint rather than a list: somebody who is
 * self-excluded does not also need to be told about their daily limit.
 */
export function blockerFor(
  allowance: TradeAllowance | null,
  amount: string,
  money: (value: string | number) => string,
): Blocker | null {
  if (allowance === null) return null;

  if (allowance.selfExcluded) {
    return {
      message: `You are self-excluded, so trading is closed. Support can help: ${allowance.helpline}`,
      hard: true,
    };
  }

  if (allowance.cooloffUntil !== null && new Date(allowance.cooloffUntil) > new Date()) {
    return {
      message: `You are on a cool-off until ${new Date(allowance.cooloffUntil).toLocaleString('en-NG')}.`,
      hard: true,
    };
  }

  const entered = Number.parseFloat(amount);
  const staked = Number.parseFloat(allowance.stakedToday);
  const limit = Number.parseFloat(allowance.stakeLimit);
  const capLeft =
    allowance.tierCapRemaining === null ? null : Number.parseFloat(allowance.tierCapRemaining);

  // The tier cap first: it is the one a person can actually clear today, by
  // verifying a contact, so it is the more useful thing to say.
  if (capLeft !== null && capLeft <= 0) {
    return {
      message: `Unverified accounts can hold ${money(allowance.escrowed)} at most across open markets, and you are at it. Verify your email or phone to lift this.`,
      hard: true,
    };
  }
  if (capLeft !== null && Number.isFinite(entered) && entered > capLeft) {
    return {
      message: `That is over what an unverified account can add — ${money(capLeft)} left. Verify your email or phone to lift the cap.`,
      hard: false,
    };
  }

  if (Number.isFinite(limit) && Number.isFinite(staked)) {
    const left = limit - staked;
    if (left <= 0) {
      return { message: `You have reached today's stake limit of ${money(limit)}.`, hard: true };
    }
    if (Number.isFinite(entered) && entered > left) {
      return {
        message: `That is over today's stake limit — ${money(left)} left of ${money(limit)}.`,
        hard: false,
      };
    }
  }

  return null;
}
