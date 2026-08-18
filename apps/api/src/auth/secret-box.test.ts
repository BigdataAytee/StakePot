import { describe, expect, it } from 'vitest';

import { isSealed, open, seal } from './secret-box';

/**
 * Encryption at rest for TOTP seeds (security review gap 3).
 *
 * `SECRETS_KEY` is set by the test setup; these check the properties the
 * storage relies on rather than the cipher itself, which is Node's.
 */
describe('secret box', () => {
  it('round-trips a secret', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(open(seal(secret))).toBe(secret);
  });

  it('does not leak the plaintext into the stored form', () => {
    const sealed = seal('JBSWY3DPEHPK3PXP');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(isSealed(sealed)).toBe(true);
  });

  it('produces a different ciphertext each time, so equal secrets are not equal rows', () => {
    expect(seal('same-secret')).not.toBe(seal('same-secret'));
  });

  it('refuses a tampered value rather than returning rubbish', () => {
    const sealed = seal('JBSWY3DPEHPK3PXP');
    const parts = sealed.split('.');
    // Flip a character in the ciphertext.
    const body = parts[3]!;
    parts[3] = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
    expect(() => open(parts.join('.'))).toThrow(/could not open/);
  });

  it('passes through legacy plaintext, so already-enrolled staff are not locked out', () => {
    // Rows written before encryption existed. They are re-sealed on next use.
    expect(open('JBSWY3DPEHPK3PXP')).toBe('JBSWY3DPEHPK3PXP');
    expect(isSealed('JBSWY3DPEHPK3PXP')).toBe(false);
  });
});
