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
