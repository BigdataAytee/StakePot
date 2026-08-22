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

/** The named tiers, as an operator pins them on a source. */
export type Cadence = 'auto' | 'urgent' | 'normal' | 'background';

/**
 * The tiers, in milliseconds.
 *
 * Named rather than inlined so the Research tab can print the same words the
 * scheduler acts on. An operator reading "urgent · every 1m" and a sweep
 * deciding 60s from a different constant is how a dashboard stops being
 * evidence.
 */
export const CADENCE_MS: Readonly<Record<Exclude<Cadence, 'auto'>, number>> = {
  urgent: 60_000,
  normal: 5 * 60_000,
  background: 45 * 60_000,
};

/** Inside this many hours of settlement, a source's markets make it urgent. */
export const URGENT_WINDOW_HOURS = 24;

/**
 * A source no live market depends on at all.
 *
 * Longer than `background`, and the distinction is real rather than tidy:
 * background is "nothing is happening soon", idle is "nothing is listening".
 * A source kept for a season that has not started should cost less than one
 * feeding a market a fortnight out.
 */
export const IDLE_MS = 6 * 3_600_000;

export interface CadenceInput {
  /** What the operator pinned, if anything. `auto` follows the markets. */
  readonly cadence: Cadence;
  /** Hours to the nearest settlement among the markets this source feeds. */
  readonly hoursToNearestSettlement: number | null;
  /**
   * Consecutive failures. Backoff is part of the cadence rather than bolted on
   * beside it: a source that has failed six times in a row and is still being
   * asked every minute is not being polled, it is being hammered.
   */
  readonly failureCount?: number;
  /**
   * True when now is inside the source's declared publication window — the
   * hour the NBS posts CPI, the morning CBN puts up rates. Outside it, a
   * calendar source drops to background whatever else is true.
   */
  readonly inPublishWindow?: boolean | undefined;
}

/**
 * How long to wait before reading this source again.
 *
 * The rule in one line: **the markets decide, the operator can override, and
 * failure slows everything down.**
 *
 * `auto` is the default and the interesting case. A source is urgent because a
 * market it feeds settles within the day — not because somebody remembered to
 * mark it urgent, and not still urgent a week after that market paid out.
 * Escalation and fallback both happen because the same function is asked again
 * five minutes later and the answer has changed.
 *
 * Calendar sources are the exception that would otherwise waste the most
 * requests: the NBS posts CPI once a month. Polling it every five minutes for
 * thirty days to catch one publication is 8,600 requests for one item. Given a
 * publication window, it sits on background until the window opens and then
 * polls like anything else urgent.
 */
export function crawlIntervalMs(input: CadenceInput | number | null): number {
  // The old signature — a bare hours-to-settlement — still works, because the
  // sweep is not the only caller and a two-argument refactor across every one
  // of them buys nothing.
  const normalised: CadenceInput =
    input === null || typeof input === 'number'
      ? { cadence: 'auto', hoursToNearestSettlement: input }
      : input;

  const { cadence, hoursToNearestSettlement, failureCount = 0 } = normalised;

  // Backoff first: it can only ever slow things down, so it composes with
  // whatever the rest of the rules decide.
  const backoff = failureCount <= 0 ? 1 : Math.min(2 ** failureCount, 32);

  if (cadence !== 'auto') return CADENCE_MS[cadence] * backoff;

  // A calendar source outside its window is background whatever its markets
  // are doing — the publication is not going to happen early.
  if (normalised.inPublishWindow === false) return CADENCE_MS.background * backoff;

  if (hoursToNearestSettlement === null) return IDLE_MS * backoff;
  if (hoursToNearestSettlement <= URGENT_WINDOW_HOURS) return CADENCE_MS.urgent * backoff;
  if (hoursToNearestSettlement <= 7 * 24) return CADENCE_MS.normal * backoff;
  return CADENCE_MS.background * backoff;
}

/** The tier a source is actually on right now, for the Research tab to print. */
export function cadenceLabel(input: CadenceInput): Exclude<Cadence, 'auto'> {
  const ms = crawlIntervalMs({ ...input, failureCount: 0 });
  if (ms <= CADENCE_MS.urgent) return 'urgent';
  if (ms <= CADENCE_MS.normal) return 'normal';
  return 'background';
}

/**
 * Nigeria has one timezone and no daylight saving. WAT is UTC+1, always, which
 * is why a publish window can be a plain offset rather than a tz database.
 */
const WAT_OFFSET_MINUTES = 60;

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * Is this source inside the window it is expected to publish in?
 *
 * Some Tier-1 sources publish on a calendar rather than continuously: NBS puts
 * out CPI mid-month, the CBN posts rates on working-day mornings. Polling those
 * round the clock is 1,400 requests a day to be told nothing has changed, and
 * polling them on a plain interval means finding a monthly release up to an
 * hour late. So a source may carry a window, and outside it drops to
 * background while inside it polls hard.
 *
 * The grammar is small on purpose — an operator adds these from a phone:
 *
 * - `08:00-11:00`               — every day, that window, WAT
 * - `mon-fri 08:00-10:30`       — weekdays only
 * - `d14-18 09:00-15:00`        — the 14th to the 18th of the month
 * - `mon,wed,fri 07:00-08:00`   — listed days
 *
 * Returns `undefined` when there is no window, which is not the same as
 * `false`: no window means the cadence tier decides alone, and a source with a
 * malformed window is treated as having none rather than being silenced by a
 * typo.
 */
export function inPublishWindow(spec: string | null | undefined, at: Date): boolean | undefined {
  if (spec === null || spec === undefined || spec.trim().length === 0) return undefined;

  const local = new Date(at.getTime() + WAT_OFFSET_MINUTES * 60_000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const weekday = DAYS[local.getUTCDay()] ?? 'sun';
  const dayOfMonth = local.getUTCDate();

  let sawTime = false;
  let matches = true;

  for (const token of spec.trim().toLowerCase().split(/\s+/)) {
    const time = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(token);
    if (time !== null) {
      const from = Number(time[1]) * 60 + Number(time[2]);
      const to = Number(time[3]) * 60 + Number(time[4]);
      sawTime = true;
      // A window that wraps midnight is written 22:00-02:00 and means what it
      // looks like; comparing it as a straight range would mean never.
      matches &&= from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
      continue;
    }

    const dom = /^d(\d{1,2})(?:-(\d{1,2}))?$/.exec(token);
    if (dom !== null) {
      const from = Number(dom[1]);
      const to = dom[2] === undefined ? from : Number(dom[2]);
      matches &&= dayOfMonth >= from && dayOfMonth <= to;
      continue;
    }

    const days = daysIn(token);
    if (days !== null) {
      matches &&= days.includes(weekday);
      continue;
    }

    // A token we do not understand. Treated as no window at all rather than as
    // a closed one: the failure mode of a typo should be polling normally, not
    // a source that silently never gets read.
    return undefined;
  }

  return sawTime ? matches : undefined;
}

/** `mon`, `mon-fri`, `mon,wed,fri` — or null if this is not a day token. */
function daysIn(token: string): string[] | null {
  const range = /^([a-z]{3})-([a-z]{3})$/.exec(token);
  if (range !== null) {
    const from = DAYS.indexOf(range[1] as (typeof DAYS)[number]);
    const to = DAYS.indexOf(range[2] as (typeof DAYS)[number]);
    if (from < 0 || to < 0) return null;
    const out: string[] = [];
    for (let i = from; ; i = (i + 1) % 7) {
      out.push(DAYS[i] as string);
      if (i === to) break;
    }
    return out;
  }

  const listed = token.split(',');
  if (listed.every((day) => DAYS.includes(day as (typeof DAYS)[number]))) return listed;
  return null;
}
