import { afterEach, describe, expect, it } from 'vitest';

import { EnvSecretsProvider, useSecretsProvider } from '../config/secrets';
import { isSealed, needsResealing, open, seal, SecretBoxError } from './secret-box';

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

describe('rotation (§2.11)', () => {
  const OLD = 'an-old-key-that-is-comfortably-long-enough';
  const NEW = 'a-new-key-that-is-also-comfortably-long-enough';

  afterEach(() => {
    useSecretsProvider(new EnvSecretsProvider());
  });

  /** A provider standing in for whatever manager the deployment uses. */
  function keys(...versions: string[]): void {
    useSecretsProvider({ versions: () => versions });
  }

  it('opens a value sealed under a retired key while it is still accepted', () => {
    keys(OLD);
    const sealed = seal('the-totp-seed');

    // The rotation: new key current, old one retained for reading.
    keys(NEW, OLD);
    expect(open(sealed)).toBe('the-totp-seed');
  });

  it('stops opening it once the retired key is dropped', () => {
    keys(OLD);
    const sealed = seal('the-totp-seed');

    keys(NEW);
    expect(() => open(sealed)).toThrow(SecretBoxError);
  });

  it('seals new material under the current key only', () => {
    keys(NEW, OLD);
    const sealed = seal('fresh');

    // Readable with the old key gone, which is the property that lets a
    // rotation finish: nothing new depends on the retired value.
    keys(NEW);
    expect(open(sealed)).toBe('fresh');
  });

  it('knows which rows a re-seal sweep still has to touch', () => {
    keys(OLD);
    const stale = seal('old-row');

    keys(NEW, OLD);
    expect(needsResealing(stale)).toBe(true);
    expect(needsResealing(seal('fresh-row'))).toBe(false);
  });

  it('treats a tampered row as unreadable rather than trying every key', () => {
    keys(NEW, OLD);
    const sealed = seal('honest');
    const tampered = `${sealed.slice(0, -4)}AAAA`;

    expect(() => open(tampered)).toThrow(SecretBoxError);
  });
});
