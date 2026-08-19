/**
 * §2.15b — status built on being right, not loud.
 *
 * "Accuracy score + calibration on every user profile... Category titles,
 * earned and seasonal."
 *
 * Two numbers, and they are not the same number. Accuracy is how often you
 * were right. Calibration is whether your confidence was worth anything — a
 * forecaster who says 90% and is right 90% of the time is perfectly
 * calibrated, and so is one who says 60% and is right 60% of the time. The
 * second is the harder skill and the one a market rewards, which is why the
 * spec asks for both and why a leaderboard on accuracy alone quietly promotes
 * whoever only ever bets on favourites.
 *
 * Everything here is pure. The reputation a person's public profile shows is
 * the sort of thing that gets argued about, and a computation nobody can run
 * against a fixture is a computation nobody can check.
 */

/** One settled prediction: what you paid, and whether it came in. */
export interface Call {
  /** The implied probability at entry — the price paid, 0–1. */
  probability: number;
  won: boolean;
  /** Which market family this was, for the category titles. */
  category: string;
}

/** How often they were right. Null below a sample worth quoting. */
export function accuracyOf(calls: readonly Call[], minimum = 5): number | null {
  if (calls.length < minimum) return null;
  return calls.filter((call) => call.won).length / calls.length;
}

/**
 * The Brier score: mean squared error between stated confidence and outcome.
 *
 * 0 is perfect, 1 is perfectly wrong, and 0.25 is what you get by saying "50%"
 * to everything. It is a *proper* scoring rule, which is the property that
 * matters: it cannot be gamed by shading your stated probability away from
 * what you actually believe.
 */
export function brier(calls: readonly Call[]): number | null {
  if (calls.length === 0) return null;
  const total = calls.reduce((sum, call) => {
    const outcome = call.won ? 1 : 0;
    return sum + (call.probability - outcome) ** 2;
  }, 0);
  return total / calls.length;
}

/**
 * Calibration as a 0–1 score where higher is better, for display.
 *
 * Rescaled against the 0.25 a coin-flipper scores rather than against 1, so
 * that "no skill" sits at 0 and not at 0.75. A profile figure where doing
 * nothing looks like three quarters of the way to expert is a figure that
 * flatters everybody and distinguishes nobody. Skill worse than a coin flip
 * clamps at 0 rather than going negative — the number is a badge, not a
 * punishment.
 */
export function calibrationOf(calls: readonly Call[], minimum = 5): number | null {
  if (calls.length < minimum) return null;
  const score = brier(calls);
  if (score === null) return null;
  return Math.max(0, Math.min(1, 1 - score / 0.25));
}

/**
 * The reliability diagram, bucketed — what "calibration" means when somebody
 * asks to see it rather than be told it.
 *
 * Ten buckets by stated confidence, each reporting how often those calls
 * actually came in. A well-calibrated forecaster's buckets sit on the
 * diagonal. Empty buckets are dropped rather than reported as zero, because
 * "you were never right at 90%" and "you never said 90%" are different claims.
 */
export function reliability(
  calls: readonly Call[],
): { band: string; predicted: number; actual: number; sample: number }[] {
  const buckets = new Map<number, Call[]>();

  for (const call of calls) {
    const index = Math.min(9, Math.max(0, Math.floor(call.probability * 10)));
    buckets.set(index, [...(buckets.get(index) ?? []), call]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, inside]) => ({
      band: `${index * 10}–${index * 10 + 10}%`,
      predicted: inside.reduce((sum, call) => sum + call.probability, 0) / inside.length,
      actual: inside.filter((call) => call.won).length / inside.length,
      sample: inside.length,
    }));
}

/**
 * §2.15b's category titles.
 *
 * "'Oracle of Naira' (economic markets), 'Football Prophet,' 'Election Sage' —
 * resettable per season so newcomers can always climb."
 *
 * Seasonal reset is the whole design. A title held forever is a title the
 * people who arrived in year two can never win, and the point of these is to
 * give somebody a reason to keep playing rather than to record who was best in
 * 2026. The season is a caller's input for exactly that reason.
 */
/**
 * Keyed by the topic keys in `@stakeam/engine`, not by names invented here.
 *
 * The spec names three titles by example — "Oracle of Naira" (economic
 * markets), "Football Prophet", "Election Sage" — and the platform already has
 * a topic vocabulary those have to sit inside, or somebody ends up titled for
 * a category the site does not have a shelf for.
 */
export const CATEGORY_TITLES: Record<string, string> = {
  money: 'Oracle of Naira',
  sports: 'Football Prophet',
  politics: 'Election Sage',
  culture: 'Culture Caller',
  crypto: 'Chain Reader',
  tech: 'Signal Reader',
  weather: 'Sky Watcher',
};

/** The generic title, for a category with no name of its own. */
export const GENERAL_TITLE = 'Sharp Eye';

export interface TitleRules {
  /** Calls in the category before a title is possible. */
  minimumSample: number;
  /** Accuracy floor. A title is a claim; it needs evidence. */
  minimumAccuracy: number;
  /** Calibration floor, which is what stops a favourite-backer holding it. */
  minimumCalibration: number;
}

/**
 * Where the bars sit, and why.
 *
 * `minimumCalibration: 0.25` is a Brier score of 0.1875 or better — a quarter
 * of the way from a coin-flipper to perfect. That sounds modest and is not:
 * Brier punishes confident mistakes quadratically, so clearing it takes a
 * genuine read on the category rather than a lucky month.
 *
 * The first draft of this asked for 0.35, which turned out to reject a
 * forecaster calling 70% and being right 80% of the time — a good forecaster,
 * merely an under-confident one. A floor that only the best-calibrated people
 * on the platform can clear is a floor that leaves the titles unawarded, and
 * an unawarded title motivates nobody. 0.25 still refuses the favourite-backer,
 * which is the one thing it has to do.
 */
export const DEFAULT_TITLE_RULES: TitleRules = {
  minimumSample: 10,
  minimumAccuracy: 0.6,
  minimumCalibration: 0.25,
};

/**
 * The title this record earns, if any.
 *
 * Both floors, not either: accuracy alone is cleared by only ever backing
 * 90% favourites, and calibration alone is cleared by being usefully humble
 * about a losing record. The title says "this person reads this category
 * well", and that claim needs both halves.
 */
export function titleFor(
  category: string,
  calls: readonly Call[],
  rules: TitleRules = DEFAULT_TITLE_RULES,
): string | null {
  const inCategory = calls.filter((call) => call.category === category);
  if (inCategory.length < rules.minimumSample) return null;

  const accuracy = accuracyOf(inCategory, rules.minimumSample);
  const calibration = calibrationOf(inCategory, rules.minimumSample);
  if (accuracy === null || calibration === null) return null;
  if (accuracy < rules.minimumAccuracy) return null;
  if (calibration < rules.minimumCalibration) return null;

  return CATEGORY_TITLES[category] ?? GENERAL_TITLE;
}

/**
 * §2.15b's Top Calls: "the boldest correct predictions (e.g. bought at 15%,
 * resolved YES)".
 *
 * Boldness is the whole selection criterion, and it is not the same as
 * profit. The right measure is how far the call was from consensus at the
 * moment it was made — a correct call bought at 15% is a better story than a
 * larger win bought at 80%, and the showcase is a marketing asset, so the
 * story is the product.
 *
 * Scored as `1 - probability` so a longer shot always outranks a shorter one.
 * Losing calls are not ranked at all; a bold wrong call is just a wrong call.
 */
export interface CallCandidate extends Call {
  userId: string;
  marketId: string;
}

export function boldness(call: Call): number {
  return call.won ? 1 - call.probability : 0;
}

/**
 * Pick the week's showcase.
 *
 * One per person, deliberately: a single sharp week from one account would
 * otherwise fill the whole board, and a showcase that is five entries from the
 * same handle reads as a stitch-up rather than as a community.
 */
export function topCalls(
  candidates: readonly CallCandidate[],
  limit = 5,
): readonly CallCandidate[] {
  const best = new Map<string, CallCandidate>();

  for (const candidate of candidates) {
    if (!candidate.won) continue;
    const held = best.get(candidate.userId);
    if (held === undefined || boldness(candidate) > boldness(held)) {
      best.set(candidate.userId, candidate);
    }
  }

  return [...best.values()].sort((a, b) => boldness(b) - boldness(a)).slice(0, limit);
}
