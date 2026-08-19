import { afterEach, describe, expect, it } from 'vitest';

import { EnvSecretsProvider, useSecretsProvider } from '../config/secrets';
import { blindIndex, blindIndexCandidates, mask, normalise } from './pii';

const KEY = 'a-key-long-enough-for-the-blind-index-hmac';
const OLD = 'the-previous-key-also-long-enough-for-this';

afterEach(() => useSecretsProvider(new EnvSecretsProvider()));
const keys = (...versions: string[]) => useSecretsProvider({ versions: () => versions });

describe('blind index (§2.11)', () => {
  it('is stable, so a lookup by value still works', () => {
    keys(KEY);
    expect(blindIndex('email', 'Ada@Example.com')).toBe(blindIndex('email', 'ada@example.com'));
  });

  it('normalises a phone number written the way people write them', () => {
    keys(KEY);
    expect(blindIndex('phone', '+234 803 (000) 0001')).toBe(blindIndex('phone', '+2348030000001'));
  });

  it('separates the kinds so an email and a phone can never collide', () => {
    keys(KEY);
    expect(blindIndex('email', '08030000001')).not.toBe(blindIndex('phone', '08030000001'));
  });

  it('is keyed — a different key gives a different index', () => {
    keys(KEY);
    const withNew = blindIndex('email', 'ada@example.com');
    keys(OLD);
    expect(blindIndex('email', 'ada@example.com')).not.toBe(withNew);
  });

  it('offers every accepted key so a rotation does not lock anybody out', () => {
    keys(OLD);
    const before = blindIndex('email', 'ada@example.com');

    keys(KEY, OLD);
    expect(blindIndexCandidates('email', 'ada@example.com')).toContain(before);
    expect(blindIndexCandidates('email', 'ada@example.com')[0]).not.toBe(before);
  });
});

describe('masking', () => {
  it('says which account without saying who', () => {
    expect(mask('email', 'adaeze@gmail.com')).toBe('a***@gmail.com');
    expect(mask('phone', '+2348030000001')).toBe('***0001');
  });

  it('does not leak a short value by masking it into nothing', () => {
    expect(mask('phone', '0001')).toBe('***');
  });

  it('passes null through rather than masking it into a fake value', () => {
    expect(mask('email', null)).toBeNull();
  });

  it('lower-cases an email but leaves a phone plus-prefix alone', () => {
    expect(normalise('email', ' Ada@Example.COM ')).toBe('ada@example.com');
    expect(normalise('phone', ' +234 803-000-0001 ')).toBe('+2348030000001');
  });
});
