import { afterEach, describe, expect, it } from 'vitest';

import { EnvSecretsProvider, useSecretsProvider } from '../config/secrets';
import {
  canonicalise,
  signReserves,
  verifyReserves,
  type ReservesFigures,
} from './reserves-export';

/**
 * §2.10's signed export. The figures come from the ledger elsewhere; what is
 * tested here is the only claim the document itself makes — that nobody has
 * edited it since we produced it.
 */
const KEY = 'a-reserves-signing-key-long-enough-to-use';
const OLD = 'the-previous-reserves-signing-key-also-long';

const FIGURES: ReservesFigures = {
  currency: 'SPC',
  userLiabilities: '1250000.00',
  totalIssued: '1250000.00',
  platformFees: '43120.55',
  surplus: '0.00',
  byFundClass: {
    user_escrow: '400000.00',
    user_available: '850000.00',
    platform_fees: '43120.55',
    prize_pool: '0.00',
  },
  accounts: 3140,
  reconciliation: { runDate: '2026-08-19', status: 'clean', diff: '0.00' },
};

const AT = '2026-08-19T09:00:00.000Z';

function keys(...versions: string[]): void {
  useSecretsProvider({ versions: () => versions });
}

afterEach(() => useSecretsProvider(new EnvSecretsProvider()));

describe('proof-of-reserves export', () => {
  it('signs and verifies a document', () => {
    keys(KEY);
    expect(verifyReserves(signReserves(FIGURES, AT))).toBe(true);
  });

  it('refuses a document whose figures were edited', () => {
    keys(KEY);
    const document = signReserves(FIGURES, AT);

    expect(verifyReserves({ ...document, userLiabilities: '1.00' })).toBe(false);
    expect(verifyReserves({ ...document, surplus: '999999.00' })).toBe(false);
    expect(verifyReserves({ ...document, generatedAt: '2026-08-20T09:00:00.000Z' })).toBe(false);
    expect(
      verifyReserves({
        ...document,
        byFundClass: { ...document.byFundClass, platform_fees: '9000000.00' },
      }),
    ).toBe(false);
  });

  it('still verifies an export signed before a key rotation', () => {
    keys(OLD);
    const lastQuarter = signReserves(FIGURES, AT);

    keys(KEY, OLD);
    expect(verifyReserves(lastQuarter)).toBe(true);
  });

  it('does not verify once the signing key is retired', () => {
    keys(OLD);
    const lastQuarter = signReserves(FIGURES, AT);

    keys(KEY);
    expect(verifyReserves(lastQuarter)).toBe(false);
  });

  it('produces the figures unsigned rather than failing when no key is set', () => {
    keys();
    const document = signReserves(FIGURES, AT);

    expect(document.signature).toBeNull();
    expect(document.userLiabilities).toBe('1250000.00');
    // Null is not a signature that passed.
    expect(verifyReserves(document)).toBe(false);
  });

  it('reads solvency off the surplus, negative included', () => {
    keys(KEY);
    expect(signReserves(FIGURES, AT).solvent).toBe(true);
    expect(signReserves({ ...FIGURES, surplus: '-0.01' }, AT).solvent).toBe(false);
  });

  it('canonicalises fund classes in a fixed order whatever the object order', () => {
    const shuffled: ReservesFigures = {
      ...FIGURES,
      byFundClass: {
        prize_pool: '0.00',
        user_available: '850000.00',
        platform_fees: '43120.55',
        user_escrow: '400000.00',
      },
    };

    expect(canonicalise(shuffled, AT)).toBe(canonicalise(FIGURES, AT));
  });

  it('rejects a truncated signature instead of throwing', () => {
    keys(KEY);
    const document = signReserves(FIGURES, AT);
    const signature = document.signature;
    if (signature === null) throw new Error('expected a signature');

    expect(
      verifyReserves({
        ...document,
        signature: { ...signature, value: signature.value.slice(0, 8) },
      }),
    ).toBe(false);
  });
});
