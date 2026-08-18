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
