/**
 * Third-party integration boundary — architecture §9.
 *
 * The payment and KYC providers need licences StakeAm does not hold yet, so the
 * interfaces are defined here and implemented as stubs. Application code is
 * written against these types today and the stubs are swapped for real clients
 * when the licence lands — nothing above this layer changes.
 */

export interface DepositInit {
  readonly ref: string;
  readonly checkoutUrl: string;
}

export type DepositStatus = 'success' | 'failed' | 'pending';

export interface DepositVerification {
  readonly status: DepositStatus;
  readonly amountNGN: number;
}

export interface WithdrawalInit {
  readonly ref: string;
}

export interface WithdrawalVerification {
  readonly status: DepositStatus;
}

export interface BankAccount {
  readonly accountNumber: string;
  readonly bankCode: string;
  readonly accountName?: string;
}

export type DepositChannel = 'card' | 'bank_transfer' | 'ussd' | 'bank';

export interface PaymentsProvider {
  initDeposit(userId: string, amountNGN: number, channel: DepositChannel): Promise<DepositInit>;
  verifyDeposit(ref: string): Promise<DepositVerification>;
  initWithdrawal(
    userId: string,
    amountNGN: number,
    bankAccount: BankAccount,
  ): Promise<WithdrawalInit>;
  verifyWithdrawal(ref: string): Promise<WithdrawalVerification>;
  webhookVerify(signature: string, payload: string): boolean;
}

export interface KycStart {
  readonly sessionId: string;
}

export type KycStatus = 'passed' | 'failed' | 'review';

export interface KycResult {
  readonly status: KycStatus;
  readonly ref: string;
}

export interface KycIdentifiers {
  readonly ninOrBvn: string;
}

export interface KycProvider {
  startVerification(userId: string, identifiers: KycIdentifiers): Promise<KycStart>;
  getResult(sessionId: string): Promise<KycResult>;
}

export interface SmsDispatch {
  readonly messageId: string;
}

export interface SmsProvider {
  sendOtp(phone: string, code: string): Promise<SmsDispatch>;
}
