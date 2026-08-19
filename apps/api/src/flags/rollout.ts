import { createHash } from 'node:crypto';

/**
 * Who is inside a percentage rollout (§2.13's canary gating).
 *
 * The rule that matters is stickiness: the same account must get the same
 * answer on every request, for as long as the percentage does not move. A flag
 * evaluated with `Math.random() < pct` flickers per request, which means a
 * member sees the new checkout on one page load and the old one on the next,
 * and — worse — a bug report against it is unreproducible. So the bucket is a
 * hash of (key, subject): deterministic, uniform, and different per flag so
 * that the same unlucky 5% are not the guinea pigs for everything.
 *
 * Buckets are 0–99, and `bucket < pct` is the test. That makes the rollout
 * monotonic: raising 5 to 10 keeps everyone who was already in, which is what
 * "ramp a canary" has to mean. Lowering it drops the highest buckets first and
 * never reshuffles.
 */
export function bucketOf(key: string, subject: string): number {
  const digest = createHash('sha256').update(`${key}:${subject}`).digest();
  // Two bytes is 0–65535; the modulo bias across 100 buckets is under 0.08%,
  // which is well inside the noise of any rollout decision.
  return ((digest[0] as number) * 256 + (digest[1] as number)) % 100;
}

export interface FlagState {
  key: string;
  enabled: boolean;
  rolloutPct: number;
  allowList: readonly string[];
}

/**
 * Whether a flag is on for one subject.
 *
 * `enabled` is checked first and is a genuine kill switch: turning a flag off
 * must take everybody out immediately, including the allow list, because the
 * reason somebody reaches for it is that the feature is breaking things.
 *
 * An anonymous subject gets the flag only at 100%. A visitor with no stable
 * identity cannot be kept in a consistent bucket, and quietly sampling them
 * would put the same person on both sides of an experiment across a session.
 */
export function flagOn(state: FlagState, subject: string | null): boolean {
  if (!state.enabled) return false;
  if (subject !== null && state.allowList.includes(subject)) return true;
  if (state.rolloutPct >= 100) return true;
  if (state.rolloutPct <= 0 || subject === null) return false;

  // Bucketed on the flag key, never on the percentage: bucketing on the
  // percentage would re-draw the lottery on every ramp, so going 5% → 10%
  // would swap the cohort instead of adding to it, and the members who had
  // been using the new thing for a week would lose it.
  return bucketOf(state.key, subject) < state.rolloutPct;
}
