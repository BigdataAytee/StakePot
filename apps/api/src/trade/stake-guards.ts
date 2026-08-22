import { Decimal } from '@stakeam/engine';

import type { Tx } from '../ledger/ledger.service';
import { checkTierCap } from './tier-cap';

export class StakeCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StakeCapError';
  }
}

/**
 * §2.1's Tier 0 exposure cap, in one place because there are now two doors.
 *
 * It was a private method on `TradeService` while the pot was the only way to
 * put money at risk. A resting limit order is a second one — the money leaves
 * the balance the moment the order rests — so the check has to hold there too,
 * and a copy of it in the order book would be a control that drifts from the
 * original the first time either is edited.
 *
 * Measured against escrow rather than against this one commitment: the cap is
 * on exposure, not on ticket size, or ten commitments of a tenth the size
 * would walk straight through it.
 */
export async function assertWithinTierCap(
  tx: Tx,
  userId: string,
  amount: Decimal,
  cap: Decimal,
): Promise<void> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { tier: true } });
  if (user === null) return;

  // Read through the transaction, not through the wallet service: this runs
  // inside the per-market lock, and a balance fetched outside it could be stale
  // by the time the cap is compared against it.
  const wallets = await tx.wallet.findMany({ where: { userId }, select: { escrowed: true } });
  const escrowed = wallets.reduce(
    (total, row) => total.plus(new Decimal(row.escrowed.toString())),
    new Decimal(0),
  );

  if (!checkTierCap({ tier: user.tier, escrowed, amount, cap }).allowed) {
    throw new StakeCapError(
      `unverified accounts can hold up to ${cap.toString()} SPC across open markets — ` +
        `you have ${escrowed.toString()} at stake. Verify your email or phone to lift this.`,
    );
  }
}
