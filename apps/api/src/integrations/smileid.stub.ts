import { NotImplementedError } from './errors';
import type { KycIdentifiers, KycProvider, KycResult, KycStart } from './types';

/**
 * Smile ID — architecture §9. Stub until the licence lands.
 *
 * Tier 2 (KYC-verified) accounts stay unreachable while this throws, which is
 * the correct behaviour: no NIN or BVN should be collected before there is a
 * licensed processor to send it to.
 */
export class SmileIdProvider implements KycProvider {
  readonly name = 'smileid';

  startVerification(_userId: string, _identifiers: KycIdentifiers): Promise<KycStart> {
    throw new NotImplementedError('licensed phase');
  }

  getResult(_sessionId: string): Promise<KycResult> {
    throw new NotImplementedError('licensed phase');
  }
}
