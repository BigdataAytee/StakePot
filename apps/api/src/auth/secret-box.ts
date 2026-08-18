import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { env } from '../config/env';

/**
 * Authenticated encryption for the few secrets that must be stored but must not
 * be readable from a database dump.
 *
 * The Phase 0 security review's third gap: TOTP secrets sat in `users` as
 * plaintext, so a leak of the database handed over second factors along with
 * the first. The key lives in the environment and never in Postgres, so the
 * dump alone is not enough.
 *
 * AES-256-GCM, because a second factor needs integrity as much as secrecy: a
 * silently corrupted secret would lock a member of staff out of a console they
 * are responsible for, and an attacker who can flip ciphertext bits without
 * detection can do worse. GCM's tag makes tampering a decryption failure.
 *
 * Stored as `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version prefix is
 * what makes a key rotation or an algorithm change possible later without
 * guessing at what any given row contains.
 */
const VERSION = 'v1';
const IV_BYTES = 12;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/**
 * The 32-byte key, derived from `SECRETS_KEY`.
 *
 * SHA-256 of the configured value rather than the raw bytes, so the variable
 * can be any sufficiently long string rather than exactly 32 bytes of base64 —
 * an operational detail that otherwise turns into a deployment that will not
 * boot at 3am.
 */
function key(): Buffer {
  const configured = env.SECRETS_KEY;
  if (configured === undefined || configured.length < 32) {
    throw new SecretBoxError(
      'SECRETS_KEY must be set to at least 32 characters to encrypt stored secrets',
    );
  }
  return createHash('sha256').update(configured).digest();
}

export function seal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Open a sealed value.
 *
 * A value that is not in the sealed shape is returned as-is: rows written
 * before this existed are plaintext, and refusing to read them would lock every
 * already-enrolled member of staff out at deploy time. They are re-sealed on
 * next write — see `isSealed`.
 */
export function open(stored: string): string {
  if (!isSealed(stored)) return stored;

  const [, ivPart, tagPart, bodyPart] = stored.split('.');
  if (ivPart === undefined || tagPart === undefined || bodyPart === undefined) {
    throw new SecretBoxError('sealed value is malformed');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(bodyPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Wrong key, or someone edited the row. Both are the same answer to the
    // caller and both are worth failing loudly rather than returning rubbish
    // that would present as "your code did not match".
    throw new SecretBoxError('could not open sealed value — wrong key, or the row was tampered');
  }
}

/** Whether a stored value is already sealed, as opposed to legacy plaintext. */
export function isSealed(stored: string): boolean {
  return stored.startsWith(`${VERSION}.`) && stored.split('.').length === 4;
}
