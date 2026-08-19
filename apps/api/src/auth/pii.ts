import { createHmac } from 'node:crypto';

import { secret, secretVersions } from '../config/secrets';
import { open, seal } from './secret-box';

/**
 * §2.11's "PII encryption at rest", and the awkward part of it.
 *
 * Email and phone are not like a TOTP seed. A TOTP seed is only ever read
 * back for one known account; a contact is *looked up by value* on every
 * login, and it carries a unique index that stops two accounts sharing one
 * phone number. Seal it with a random IV, as AES-GCM requires, and the same
 * address produces different ciphertext every time — which destroys both the
 * lookup and the uniqueness constraint at once.
 *
 * The answer is a blind index: a deterministic keyed hash of the normalised
 * value, stored beside the sealed value. The index is what `WHERE` and
 * `UNIQUE` use; the sealed column is what gets displayed. Keyed, not a plain
 * hash — an unkeyed hash of a phone number is reversible by anyone with a
 * list of Nigerian mobile numbers, which is a small enough space to enumerate
 * in minutes.
 *
 * The index is deliberately *not* rotated with the encryption key. Rotating it
 * would mean recomputing every index in one migration or losing the ability to
 * log anybody in, so it has its own lifetime and its own entry in
 * `secretVersions`. Verification tries every accepted version.
 */
export type PiiKind = 'email' | 'phone';

/** Normalise before hashing, or the same person indexes to two values. */
export function normalise(kind: PiiKind, value: string): string {
  const trimmed = value.trim();
  return kind === 'email' ? trimmed.toLowerCase() : trimmed.replace(/[\s()-]/g, '');
}

/**
 * The lookup key for a contact.
 *
 * Domain-separated by kind so an email and a phone number that happened to
 * normalise to the same string could never collide into one index value.
 */
export function blindIndex(kind: PiiKind, value: string): string {
  return createHmac('sha256', secret('SECRETS_KEY'))
    .update(`${kind}:${normalise(kind, value)}`)
    .digest('hex');
}

/** Every index a value could currently have, newest key first. */
export function blindIndexCandidates(kind: PiiKind, value: string): string[] {
  return secretVersions('SECRETS_KEY').map((material) =>
    createHmac('sha256', material)
      .update(`${kind}:${normalise(kind, value)}`)
      .digest('hex'),
  );
}

export function sealContact(value: string): string {
  return seal(value);
}

export function openContact(stored: string): string {
  return open(stored);
}

/**
 * What staff see before they ask to see more.
 *
 * The read-side control that matters more than the at-rest one: most PII
 * exposure is not a stolen database, it is a support console that prints
 * everybody's phone number to everybody who opens it. A masked value answers
 * "is this the right account" — which is what the agent actually needs —
 * without answering "what is this person's number".
 */
export function maskEmail(value: string): string {
  const [local = '', domain = ''] = value.split('@');
  const head = local.slice(0, 1);
  return domain === '' ? `${head}***` : `${head}***@${domain}`;
}

export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length <= 4 ? '***' : `***${digits.slice(-4)}`;
}

export function mask(kind: PiiKind, value: string | null): string | null {
  if (value === null) return null;
  return kind === 'email' ? maskEmail(value) : maskPhone(value);
}
