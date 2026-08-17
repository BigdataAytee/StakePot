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
 * Flutterwave — architecture §9. Stub until the licence lands.
 *
 * Second payments provider behind the same interface, so failover is a
 * configuration change rather than a code change.
 */
export class FlutterwaveProvider implements PaymentsProvider {
  readonly name = 'flutterwave';

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
