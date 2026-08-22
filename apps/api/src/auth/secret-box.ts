import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { keyId, MissingSecretError, secret, secretVersions } from '../config/secrets';

/**
 * Authenticated encryption for the few secrets that must be stored but must not
 * be readable from a database dump.
 *
 * The Phase 0 security review's third gap: TOTP secrets sat in `users` as
 * plaintext, so a leak of the database handed over second factors along with
 * the first. The key lives in the secrets manager and never in Postgres, so the
 * dump alone is not enough.
 *
 * AES-256-GCM, because a second factor needs integrity as much as secrecy: a
 * silently corrupted secret would lock a member of staff out of a console they
 * are responsible for, and an attacker who can flip ciphertext bits without
 * detection can do worse. GCM's tag makes tampering a decryption failure.
 *
 * Stored as `v2.<keyId>.<iv>.<tag>.<ciphertext>`, all base64url after the
 * version. The key id is what makes §2.11's "automatic rotation" survive
 * contact with rows already in the table: opening a value reaches for the key
 * that sealed it rather than assuming the current one, so a rotation does not
 * have to be a migration and does not lock anybody out at the moment it lands.
 *
 * `v1` had no key id and is still opened, with the current key, for rows
 * written before rotation existed. Nothing writes v1 any more.
 */
const VERSION = 'v2';
const IV_BYTES = 12;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/**
 * A 32-byte key from configured material.
 *
 * SHA-256 of the value rather than its raw bytes, so the secret can be any
 * sufficiently long string rather than exactly 32 bytes of base64 — an
 * operational detail that otherwise turns into a deployment that will not boot
 * at 3am.
 */
function derive(material: string): Buffer {
  return createHash('sha256').update(material).digest();
}

function current(): { material: string; key: Buffer } {
  try {
    const material = secret('SECRETS_KEY');
    return { material, key: derive(material) };
  } catch (error) {
    if (error instanceof MissingSecretError) throw new SecretBoxError(error.message);
    throw error;
  }
}

export function seal(plaintext: string): string {
  const { material, key } = current();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    keyId(material),
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Open a sealed value.
 *
 * A value that is not in a sealed shape is returned as-is: rows written before
 * this existed are plaintext, and refusing to read them would lock every
 * already-enrolled member of staff out at deploy time. They are re-sealed on
 * next write — see `isSealed`.
 */
export function open(stored: string): string {
  if (!isSealed(stored)) return stored;

  const parts = stored.split('.');
  const version = parts[0];

  const [id, ivPart, tagPart, bodyPart] =
    version === VERSION
      ? [parts[1], parts[2], parts[3], parts[4]]
      : [null, parts[1], parts[2], parts[3]];

  if (ivPart === undefined || tagPart === undefined || bodyPart === undefined) {
    throw new SecretBoxError('sealed value is malformed');
  }

  // The key that sealed it, where the envelope says which one that was. A v1
  // row predates key ids, so it gets the whole accepted list — one of them
  // wrote it, and GCM's tag says which without us having to guess.
  const accepted = secretVersions('SECRETS_KEY');
  if (accepted.length === 0) throw new SecretBoxError('SECRETS_KEY is not configured');
  const candidates = id === null ? accepted : accepted.filter((value) => keyId(value) === id);

  for (const material of candidates.length > 0 ? candidates : accepted) {
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        derive(material),
        Buffer.from(ivPart, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(bodyPart, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Wrong key for this row. Try the next accepted version before giving up
      // — mid-rotation, the right one is very often the second.
    }
  }

  // Wrong key, or someone edited the row. Both are the same answer to the
  // caller and both are worth failing loudly rather than returning rubbish
  // that would present as "your code did not match".
  throw new SecretBoxError('could not open sealed value — wrong key, or the row was tampered');
}

/** Whether a stored value is already sealed, as opposed to legacy plaintext. */
export function isSealed(stored: string): boolean {
  const parts = stored.split('.');
  if (parts[0] === VERSION) return parts.length === 5;
  return parts[0] === 'v1' && parts.length === 4;
}

/**
 * Whether a sealed value was written with a key that is no longer current.
 *
 * What a re-seal sweep is driven by after a rotation: rows that answer true
 * are still readable, but only for as long as the retired key stays in
 * `SECRETS_KEY_PREVIOUS`.
 */
export function needsResealing(stored: string): boolean {
  if (!isSealed(stored)) return true;
  const parts = stored.split('.');
  if (parts[0] !== VERSION) return true;
  try {
    return parts[1] !== keyId(secret('SECRETS_KEY'));
  } catch {
    return false;
  }
}
