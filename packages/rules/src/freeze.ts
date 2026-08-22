/**
 * When trading stops, and why it stops before the event rather than at it.
 *
 * Rule 22 of the checklist and §2.3 both say the same thing: a market freezes
 * when its event starts. The reason it matters more than it sounds is the
 * asymmetry it prevents. Once a match kicks off, a whistle blows or a figure is
 * read out, somebody knows the answer before the price does — and the damage is
 * not only that they can buy in cheap. It is that they can *sell out* to
 * somebody who has not seen the score. So the freeze blocks both directions.
 * A half-freeze that stopped buys and allowed exits would be worse than none:
 * it would look protective and quietly move the loss onto the slower trader.
 *
 * Everything here is a pure function of a clock and two timestamps, so the
 * server, the queue and every screen answer the question the same way.
 */

/**
 * How far before the event trading actually stops.
 *
 * Two minutes by default, and not zero for a mechanical reason: a trade takes
 * time to travel, queue behind the market's row lock and execute. Freezing
 * exactly at kick-off means a request sent at 14:59:59.8 can execute at
 * 15:00:00.3 with the whistle already blown. The buffer is the width of that
 * gap, made explicit rather than hoped away.
 */
export const DEFAULT_FREEZE_BUFFER_SECONDS = 120;

/** The last hour before a freeze, when the ticket starts counting down. */
export const FINAL_HOUR_MS = 3_600_000;
/** The last five minutes, which the countdown emphasises. */
export const FINAL_MINUTES_MS = 5 * 60_000;

/**
 * What a reader is told when trading is closed.
 *
 * One string, exported, because it appears on the disabled button, in the
 * sheet's refusal and in the API's rejection — and three wordings of the same
 * refusal read as three different rules.
 */
export const FROZEN_REASON = 'Trading closed — the event has started';

/**
 * The refusal, with the reason that market carries.
 *
 * One function rather than a string built at each call site: the disabled
 * button, the sheet's refusal and the API's rejection all use it, and three
 * wordings of one refusal read to a trader as three different rules.
 */
export function frozenMessage(reason?: string | null): string {
  const given = (reason ?? '').trim();
  return given.length === 0 ? FROZEN_REASON : `Trading closed — ${given}`;
}

/** Every state in which no trade may be placed, whatever the clock says. */
const CLOSED_STATES = new Set([
  'draft',
  'frozen',
  'pending_resolution',
  'dispute_window',
  'resolved',
  'voided',
]);

export type FreezePhase =
  /** Trading normally. */
  | 'open'
  /** Inside the final hour: the ticket counts down. */
  | 'closing'
  /** Inside the final five minutes. */
  | 'final'
  /** Closed. */
  | 'frozen';

export interface FreezeInput {
  /** When trading stops. Null on rows written before freeze times existed. */
  readonly freezeAt: Date | string | null;
  /** When the event itself starts, the fallback when `freezeAt` is missing. */
  readonly eventDate: Date | string;
  readonly state: string;
  readonly now?: Date;
}

export interface FreezeView {
  readonly phase: FreezePhase;
  /** The moment trading stops, resolved through the fallback. */
  readonly freezeAt: Date;
  /** Milliseconds until then; zero once frozen. */
  readonly msRemaining: number;
  readonly frozen: boolean;
}

/**
 * Where a market sits relative to its freeze.
 *
 * **The earlier of the two timestamps wins**, and that is the load-bearing
 * decision here rather than a tidy-up. `freezeAt` is normally the earlier one,
 * because it is the event less the buffer — but the two are separate columns
 * and can drift, and the direction the drift matters in is only one: a market
 * whose event moved earlier while its freeze time did not would keep trading
 * after the event had started, which is the precise thing rule 22 exists to
 * prevent. Taking the minimum means no amendment, migration or hand-edit can
 * open that window, and the cost of getting it wrong the other way is a market
 * that stopped a little early.
 *
 * A null `freezeAt` therefore falls back to the event date rather than reading
 * as "no freeze": a row written before freeze times existed should stop trading
 * at its event rather than trade on for ever because a column was added later.
 * The defect stays visible — the Manage tab lists live markets with no freeze
 * time — but it is visible *and* safe, rather than only visible.
 */
export function freezeView(input: FreezeInput): FreezeView {
  const now = input.now ?? new Date();
  const declared = at(input.freezeAt);
  const event = at(input.eventDate);
  const freezeAt =
    declared !== null && event !== null
      ? new Date(Math.min(declared.getTime(), event.getTime()))
      : (declared ?? event ?? now);
  const msRemaining = freezeAt.getTime() - now.getTime();

  if (CLOSED_STATES.has(input.state) || msRemaining <= 0) {
    return { phase: 'frozen', freezeAt, msRemaining: 0, frozen: true };
  }
  const phase: FreezePhase =
    msRemaining <= FINAL_MINUTES_MS ? 'final' : msRemaining <= FINAL_HOUR_MS ? 'closing' : 'open';

  return { phase, freezeAt, msRemaining, frozen: false };
}

/**
 * The one question the money path asks.
 *
 * A separate name from `freezeView` because the call sites are different in
 * kind: a screen wants a phase to render, and the trade pipeline wants a
 * yes or no it cannot get subtly wrong by reading the wrong field.
 */
export function isTradingFrozen(input: FreezeInput): boolean {
  return freezeView(input).frozen;
}

/** The freeze time a market gets at creation. */
export function freezeAtFor(
  eventDate: Date,
  bufferSeconds: number = DEFAULT_FREEZE_BUFFER_SECONDS,
): Date {
  return new Date(eventDate.getTime() - Math.max(0, bufferSeconds) * 1000);
}

function at(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
