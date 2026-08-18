import { Injectable } from '@nestjs/common';
import type { Currency, LedgerType } from '@prisma/client';
import { Decimal } from 'decimal.js';

import { LedgerService, type Tx } from '../ledger/ledger.service';
import { escrow, issue, release } from '../ledger/posting';
import { PrismaService } from '../prisma/prisma.service';

export class InsufficientFundsError extends Error {
  constructor(
    readonly userId: string,
    readonly requested: Decimal,
    readonly available: Decimal,
  ) {
    super(
      `insufficient funds for ${userId}: requested ${requested.toString()}, ` +
        `available ${available.toString()}`,
    );
    this.name = 'InsufficientFundsError';
  }
}

export const DEFAULT_CURRENCY: Currency = 'SPC';

/**
 * The user-facing money operations (§2.2).
 *
 * Every one of them is a ledger transaction. There is deliberately no method
 * here that adjusts a wallet directly — a balance that changed without a ledger
 * row behind it is precisely what the nightly reconciliation exists to catch,
 * and it should never be reachable from application code in the first place.
 */
@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  /** Issue points to a user — signup bonus, starter balance, prize. */
  async issue(params: {
    userId: string;
    amount: Decimal;
    type: LedgerType;
    ref: string;
    currency?: Currency;
    tx?: Tx;
  }): Promise<void> {
    const currency = params.currency ?? DEFAULT_CURRENCY;
    if (params.amount.lte(0)) {
      throw new Error(`issue amount must be > 0, received ${params.amount.toString()}`);
    }

    const run = async (tx: Tx): Promise<void> => {
      await this.ledger.post(
        tx,
        issue({ userId: params.userId, amount: params.amount, type: params.type, currency }),
        params.ref,
      );
    };

    await (params.tx ? run(params.tx) : this.prisma.$transaction(run));
  }

  /**
   * Move money available → escrow.
   *
   * The balance is re-read inside the transaction rather than trusted from a
   * prior read: two concurrent stakes must not both price off the same
   * available balance, the same way §11 serialises two trades on one market.
   */
  async escrow(params: {
    userId: string;
    marketId: string;
    amount: Decimal;
    type: LedgerType;
    ref: string;
    currency?: Currency;
    tx?: Tx;
  }): Promise<void> {
    const currency = params.currency ?? DEFAULT_CURRENCY;
    if (params.amount.lte(0)) {
      throw new Error(`escrow amount must be > 0, received ${params.amount.toString()}`);
    }

    const run = async (tx: Tx): Promise<void> => {
      const wallet = await tx.wallet.findUnique({
        where: { userId_currency: { userId: params.userId, currency } },
      });
      const available = new Decimal(wallet?.available.toString() ?? '0');
      if (available.lt(params.amount)) {
        throw new InsufficientFundsError(params.userId, params.amount, available);
      }

      await this.ledger.post(
        tx,
        escrow({
          userId: params.userId,
          marketId: params.marketId,
          amount: params.amount,
          type: params.type,
          currency,
        }),
        params.ref,
      );
    };

    await (params.tx ? run(params.tx) : this.prisma.$transaction(run));
  }

  /** Move money escrow → available: a payout or a void refund. */
  async release(params: {
    userId: string;
    marketId: string;
    amount: Decimal;
    type: LedgerType;
    ref: string;
    currency?: Currency;
    tx?: Tx;
  }): Promise<void> {
    const currency = params.currency ?? DEFAULT_CURRENCY;
    if (params.amount.lte(0)) {
      throw new Error(`release amount must be > 0, received ${params.amount.toString()}`);
    }

    const run = async (tx: Tx): Promise<void> => {
      await this.ledger.post(
        tx,
        release({
          userId: params.userId,
          marketId: params.marketId,
          amount: params.amount,
          type: params.type,
          currency,
        }),
        params.ref,
      );
    };

    await (params.tx ? run(params.tx) : this.prisma.$transaction(run));
  }

  async balanceOf(
    userId: string,
    currency: Currency = DEFAULT_CURRENCY,
  ): Promise<{ available: Decimal; escrowed: Decimal }> {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId_currency: { userId, currency } },
    });
    return {
      available: new Decimal(wallet?.available.toString() ?? '0'),
      escrowed: new Decimal(wallet?.escrowed.toString() ?? '0'),
    };
  }
}
