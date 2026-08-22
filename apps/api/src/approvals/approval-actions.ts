import { z } from 'zod';

/**
 * Everything four eyes are required for (§2.10).
 *
 * "Withdrawals above [threshold], manual ledger adjustments, market voids after
 * activation, and bond forfeitures require two distinct staff approvals,
 * enforced by an `approvals` workflow table — a single admin credential can
 * never move significant user money."
 *
 * The registry is the whole rule. An action that is not listed here has no
 * schema and no executor, so it cannot be proposed at all — the workflow cannot
 * be used to smuggle through something nobody wrote down.
 */

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'amounts cross this boundary as decimal strings, never floats');

export const APPROVAL_ACTIONS = {
  /**
   * §2.4's void path is free before activation — the market failed to start and
   * the job refunds it. After activation it is a human unwinding a live market,
   * which is exactly where one credential must not be enough.
   */
  'market.void_after_activation': {
    schema: z.object({ marketId: z.string().min(1) }),
    /** Moves user money, so the approver must be Finance or Admin (§6.4b). */
    money: true,
    summary: 'Void a live market and refund every stake',
  },
  'bond.forfeit': {
    schema: z.object({ marketId: z.string().min(1) }),
    money: true,
    summary: 'Forfeit a creator’s conduct bond to platform fees',
  },
  /**
   * Reopening a frozen market.
   *
   * The dangerous direction, and the only reason it exists at all is the case
   * where the freeze itself was the mistake — a fixture postponed after we
   * froze, a market frozen on a leak that turned out to be nothing. Everything
   * about that is asymmetric: if the event *did* start, whoever presses this is
   * handing an informed trader a market full of people who have not seen the
   * score.
   *
   * So it takes two people, and the payload must carry a new freeze time. A
   * market reopened without moving its clock re-freezes on the next sweep,
   * which would make this look broken rather than refused.
   */
  'market.unfreeze': {
    schema: z.object({
      marketId: z.string().min(1),
      freezeAt: z.string().datetime(),
    }),
    money: true,
    summary: 'Reopen a frozen market for trading',
  },
  /**
   * A platform seed in LIVE mode.
   *
   * In TEST mode the seed tool executes straight away: it spends points, and a
   * second signature on points is ceremony that teaches people to click
   * through ceremony. In LIVE mode the same button spends real naira into a
   * market the platform runs, which is precisely the shape §6.4b exists for —
   * one credential must not be enough to move company money into a market
   * whose odds the company also publishes.
   *
   * The action is registered now, unreachable, because LIVE mode is off until
   * licensing. Registering it later, under a launch deadline, is how the
   * four-eyes step gets skipped "just for the first one".
   */
  'liquidity.seed_live': {
    schema: z.object({
      marketId: z.string().min(1),
      perOutcome: decimalString,
      requestId: z.string().min(1),
    }),
    money: true,
    summary: 'Seed a market with real money, equally across every outcome',
  },
  'ledger.adjust': {
    schema: z.object({
      userId: z.string().min(1),
      /** Signed. Positive credits the user; negative debits them. */
      amount: decimalString,
      marketId: z.string().min(1).optional(),
    }),
    money: true,
    summary: 'Correct a balance with a reversing entry',
  },
  'config.change': {
    schema: z.object({ key: z.string().min(1), value: z.unknown() }),
    money: true,
    summary: 'Change a platform_config value',
  },
  /**
   * §6.8's "weekly prize runs (approve airtime payouts)".
   *
   * The run and its awards are drawn up first and reviewable as a table; this
   * is only the signature that moves the money. A promotional competition
   * paying out to a leaderboard is exactly the kind of discretionary spend one
   * credential must not be able to authorise alone.
   */
  'prize.run': {
    schema: z.object({ runId: z.string().min(1) }),
    money: true,
    summary: 'Pay a weekly prize run to its leaderboard winners',
  },
  /**
   * Registered but not executable: deposits and withdrawals arrive with the
   * licence (§9). The threshold config and the inbox exist now so the control
   * is not something to remember to build later.
   */
  'withdrawal.release': {
    schema: z.object({ userId: z.string().min(1), amount: decimalString }),
    money: true,
    summary: 'Release a withdrawal above the four-eyes threshold',
  },
} as const;

export type ApprovalActionType = keyof typeof APPROVAL_ACTIONS;

export const APPROVAL_ACTION_TYPES = Object.keys(APPROVAL_ACTIONS) as ApprovalActionType[];

export function isApprovalAction(value: string): value is ApprovalActionType {
  return Object.prototype.hasOwnProperty.call(APPROVAL_ACTIONS, value);
}
