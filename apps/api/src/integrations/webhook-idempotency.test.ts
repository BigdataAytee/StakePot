import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  decideWebhook,
  verifySignature,
  type ProcessedEvents,
  type WebhookEvent,
} from './webhook-idempotency';

const SECRET = 'a-provider-webhook-secret';

/** An in-memory stand-in for the processed-events table. */
function store(): ProcessedEvents & { ids: Set<string> } {
  const ids = new Set<string>();
  return {
    ids,
    seen: (id) => Promise.resolve(ids.has(id)),
    remember: (id) => {
      ids.add(id);
      return Promise.resolve();
    },
  };
}

function event(over: Partial<WebhookEvent> = {}): WebhookEvent {
  const raw = over.raw ?? JSON.stringify({ event: 'charge.success', data: { reference: 'dep_1' } });
  return {
    id: 'evt_1',
    type: 'charge.success',
    ref: 'dep_1',
    amountNGN: 5000,
    raw,
    signature: createHmac('sha512', SECRET).update(raw).digest('hex'),
    ...over,
  };
}

describe('payment webhook idempotency (§2.16)', () => {
  it('credits a genuine first delivery', async () => {
    const processed = store();
    const outcome = await decideWebhook(event(), SECRET, processed);

    expect(outcome).toEqual({
      action: 'credit',
      eventId: 'evt_1',
      ref: 'dep_1',
      amountNGN: 5000,
    });
  });

  it('credits once when the provider retries the same event', async () => {
    // The whole point. Providers retry on timeout, and the second delivery is
    // byte-identical to the first.
    const processed = store();
    const delivery = event();

    const first = await decideWebhook(delivery, SECRET, processed);
    expect(first.action).toBe('credit');
    await processed.remember(delivery.id);

    const second = await decideWebhook(delivery, SECRET, processed);
    expect(second).toEqual({ action: 'ignored', reason: 'replay' });
  });

  it('still credits a genuinely different event for the same reference', async () => {
    // Deduping on the body rather than the event id would lose this one.
    const processed = store();
    await processed.remember('evt_1');

    const outcome = await decideWebhook(event({ id: 'evt_2' }), SECRET, processed);
    expect(outcome.action).toBe('credit');
  });

  it('rejects a forged payload before it can consume an idempotency key', async () => {
    // The ordering that matters: if a bad signature were recorded as seen, an
    // attacker could suppress a real deposit by guessing its event id first.
    const processed = store();
    const forged = event({ signature: createHmac('sha512', 'wrong').update('{}').digest('hex') });

    expect(await decideWebhook(forged, SECRET, processed)).toEqual({
      action: 'rejected',
      reason: 'bad_signature',
    });
    expect(processed.ids.has('evt_1')).toBe(false);
  });

  it('rejects a delivery with no event id rather than inventing one', async () => {
    const outcome = await decideWebhook(event({ id: '  ' }), SECRET, store());
    expect(outcome).toEqual({ action: 'rejected', reason: 'no_event_id' });
  });

  it('ignores event types it does not handle', async () => {
    const outcome = await decideWebhook(event({ type: 'charge.pending' }), SECRET, store());
    expect(outcome).toEqual({ action: 'ignored', reason: 'unhandled_type' });
  });

  it('refuses a zero or negative amount', async () => {
    expect((await decideWebhook(event({ amountNGN: 0 }), SECRET, store())).action).toBe('rejected');
    expect((await decideWebhook(event({ amountNGN: -100 }), SECRET, store())).action).toBe(
      'rejected',
    );
  });

  it('checks the signature over the raw bytes, not a re-serialisation', async () => {
    // Re-serialising JSON reorders keys and changes whitespace; a handler that
    // signs its own parse of the body rejects every genuine delivery.
    const raw = '{"event":"charge.success",  "data":{"reference":"dep_1"}}';
    const signature = createHmac('sha512', SECRET).update(raw).digest('hex');

    expect(verifySignature(raw, signature, SECRET)).toBe(true);
    expect(verifySignature(JSON.stringify(JSON.parse(raw)), signature, SECRET)).toBe(false);
  });

  it('does not throw on a truncated signature', async () => {
    const outcome = await decideWebhook(event({ signature: 'abcd' }), SECRET, store());
    expect(outcome).toEqual({ action: 'rejected', reason: 'bad_signature' });
  });
});
