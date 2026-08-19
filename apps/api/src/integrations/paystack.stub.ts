import { NotImplementedError } from './errors';
import type {
  BankAccount,
  DepositChannel,
  DepositInit,
  DepositVerification,
  PaymentsProvider,
  WithdrawalInit,
  WithdrawalVerification,
} from './types';

/**
 * Paystack — architecture §9. Stub until the licence lands.
 *
 * Every method throws. Do not soften these into no-ops or fixtures: a caller
 * that reaches here is trying to move real naira and must fail closed.
 *
 * **Whatever calls `initWithdrawal` must require a verified contact first**
 * (§2.1 Tier 1), and KYC on top of it per `kyc_required_at`. That check does
 * not live here — a payments client should not be deciding who is allowed to be
 * paid — but it has to exist before this stub becomes real, and it is the only
 * place contact verification is *mandatory*. Entry is deliberately free: Tier 0
 * trades both shelves with its starter balance and is never sent to a code box
 * on the way in. Money leaving is the boundary where knowing who somebody is
 * stops being optional.
 */
export class PaystackProvider implements PaymentsProvider {
  readonly name = 'paystack';

  initDeposit(_userId: string, _amountNGN: number, _channel: DepositChannel): Promise<DepositInit> {
    throw new NotImplementedError('licensed phase');
  }

  verifyDeposit(_ref: string): Promise<DepositVerification> {
    throw new NotImplementedError('licensed phase');
  }

  initWithdrawal(
    _userId: string,
    _amountNGN: number,
    _bankAccount: BankAccount,
  ): Promise<WithdrawalInit> {
    throw new NotImplementedError('licensed phase');
  }

  verifyWithdrawal(_ref: string): Promise<WithdrawalVerification> {
    throw new NotImplementedError('licensed phase');
  }

  webhookVerify(_signature: string, _payload: string): boolean {
    throw new NotImplementedError('licensed phase');
  }
}
