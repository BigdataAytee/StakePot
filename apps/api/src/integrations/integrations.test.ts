import { describe, expect, it } from 'vitest';
// Imported from the stub files directly rather than the barrel: the barrel also
// pulls in the Termii client, which parses the environment at import time.
import { NotImplementedError } from './errors';
import { FlutterwaveProvider } from './flutterwave.stub';
import { PaystackProvider } from './paystack.stub';
import { SmileIdProvider } from './smileid.stub';

describe('licensed-phase integration stubs', () => {
  it('paystack fails closed on every method', () => {
    const paystack = new PaystackProvider();
    expect(() => paystack.initDeposit('u1', 5000, 'card')).toThrow(NotImplementedError);
    expect(() => paystack.verifyDeposit('ref')).toThrow(NotImplementedError);
    expect(() =>
      paystack.initWithdrawal('u1', 5000, { accountNumber: '0000000000', bankCode: '058' }),
    ).toThrow(NotImplementedError);
    expect(() => paystack.verifyWithdrawal('ref')).toThrow(NotImplementedError);
    expect(() => paystack.webhookVerify('sig', '{}')).toThrow(NotImplementedError);
  });

  it('flutterwave fails closed on every method', () => {
    const flutterwave = new FlutterwaveProvider();
    expect(() => flutterwave.initDeposit('u1', 5000, 'bank_transfer')).toThrow(NotImplementedError);
    expect(() => flutterwave.webhookVerify('sig', '{}')).toThrow(NotImplementedError);
  });

  it('smile id fails closed on every method', () => {
    const smileId = new SmileIdProvider();
    expect(() => smileId.startVerification('u1', { ninOrBvn: '00000000000' })).toThrow(
      NotImplementedError,
    );
    expect(() => smileId.getResult('session')).toThrow(NotImplementedError);
  });
});
