import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * §2.16 — the webhook path, and the one property it must have.
 *
 * A payment provider retries. That is not an edge case, it is the documented
 * behaviour of every provider in this space: if our endpoint is slow, times
 * out, or returns anything other than a 2xx, the same "deposit succeeded"
 * event arrives again — sometimes minutes later, sometimes days. A handler
 * that credits on receipt credits twice, and the second credit is real money
 * we did not receive.
 *
 * The matrix called this out as the fintech gap worth closing "before the
 * licence, not after". The endpoints themselves are correctly not built in
 * points mode, but the *rule* can be written and tested now, against a fake,
 * and that is what this is. When the licence lands, the handler is a thin
 * shell over these two functions rather than the place somebody first thinks
 * about replays under pressure.
 *
 * Two separate concerns, deliberately not merged:
 *  - **authenticity** — did the provider send this? (signature)
 *  - **novelty** — have we already acted on it? (idempotency key)
 *
 * Merging them is a classic mistake: dedupe on the signature and two genuinely
 * distinct events that happen to carry the same body collapse into one, which
 * loses a deposit.
 */
export interface WebhookEvent {
  /** The provider's own event id. The idempotency key, and it is theirs. */
  id: string;
  type: string;
  /** The reference the deposit was initialised with. */
  ref: string;
  amountNGN: number;
  /** Raw body exactly as received — signatures are over bytes, not objects. */
  raw: string;
  signature: string;
}

export type WebhookOutcome =
  | { action: 'credit'; eventId: string; ref: string; amountNGN: number }
  | { action: 'ignored'; reason: 'replay' | 'unhandled_type' }
  | { action: 'rejected'; reason: 'bad_signature' | 'no_event_id' | 'non_positive_amount' };

/** What the handler needs to know about what it has already done. */
export interface ProcessedEvents {
  seen(eventId: string): Promise<boolean>;
  /**
   * Record the event as handled.
   *
   * Must be in the same transaction as the credit it authorises. A record
   * written after a successful credit leaves a window where a retry arriving
   * mid-flight credits again; written before, and a failed credit permanently
   * suppresses a real deposit. Same transaction, or neither.
   */
  remember(eventId: string): Promise<void>;
}

/** Constant-time signature check over the raw body. */
export function verifySignature(raw: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha512', secret).update(raw).digest('hex');
  const offered = Buffer.from(signature, 'hex');
  const candidate = Buffer.from(expected, 'hex');
  return candidate.length === offered.length && timingSafeEqual(candidate, offered);
}

/**
 * Decide what to do with one webhook delivery.
 *
 * Pure of the database except through `ProcessedEvents`, so the whole decision
 * table is testable without a provider or a ledger.
 *
 * The ordering matters and is not arbitrary: signature first, because an
 * unauthenticated payload must not be allowed to consume an idempotency key
 * and thereby suppress the real event that follows.
 */
export async function decideWebhook(
  event: WebhookEvent,
  secret: string,
  processed: ProcessedEvents,
): Promise<WebhookOutcome> {
  if (!verifySignature(event.raw, event.signature, secret)) {
    return { action: 'rejected', reason: 'bad_signature' };
  }

  // No id means no way to tell a retry from a new event. Refuse rather than
  // invent one from the body: two genuine deposits of the same amount on the
  // same ref would hash identically, and one of them would vanish.
  if (event.id.trim().length === 0) {
    return { action: 'rejected', reason: 'no_event_id' };
  }

  if (event.type !== 'charge.success') {
    return { action: 'ignored', reason: 'unhandled_type' };
  }

  if (!(event.amountNGN > 0)) {
    return { action: 'rejected', reason: 'non_positive_amount' };
  }

  if (await processed.seen(event.id)) {
    return { action: 'ignored', reason: 'replay' };
  }

  return { action: 'credit', eventId: event.id, ref: event.ref, amountNGN: event.amountNGN };
}
