import { describe, expect, it } from 'vitest';

import { ReferralService } from './referral.service';

/**
 * The code is derived from the user id, so it can be checked without a
 * database — which is the point of deriving it rather than storing a row.
 */
const codeFor = (userId: string): string =>
  ReferralService.prototype.codeFor.call({} as ReferralService, userId);

describe('referral codes (§2.17)', () => {
  it('is stable for an account', () => {
    expect(codeFor('user-a')).toBe(codeFor('user-a'));
  });

  it('differs between accounts', () => {
    expect(codeFor('user-a')).not.toBe(codeFor('user-b'));
  });

  it('is six characters a person can read out over the phone', () => {
    const code = codeFor('some-account-id');
    expect(code).toHaveLength(6);
    // No 0/O or 1/I/L — the pairs that get mistyped when somebody dictates a
    // code across a room.
    expect(code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  });

  it('spreads across the alphabet rather than clustering', () => {
    const codes = Array.from({ length: 500 }, (_, index) => codeFor(`user-${index}`));
    expect(new Set(codes).size).toBeGreaterThan(495);
  });
});
