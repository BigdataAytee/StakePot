import { API_URL } from './api';

/**
 * Placing a trade, and waiting for it to actually exist.
 *
 * Shared by the bottom sheet and the detail page's side panel, because the
 * hard part is not the POST — it is §11's queue, and a second implementation
 * of the wait is a second chance to get it wrong on the screen that matters.
 */

/**
 * Wait for a queued trade to be executed, or to be refused.
 *
 * §11's queue answers "accepted" the moment a busy market's trade is safely on
 * the stream, and the worker executes it a moment later. Somebody who has just
 * committed money is owed the outcome, not an optimistic screen: this polls
 * the status endpoint until the trade exists or the refusal does.
 *
 * It gives up after a minute and says so. Giving up is not the same as losing
 * the trade — the queue still holds it and the wallet will show it — so the
 * message says that rather than implying the money went nowhere.
 */
async function waitForFill(requestId: string, token: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const response = await fetch(`${API_URL}/trades/${requestId}/status`, {
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (response === null || !response.ok) continue;

    const body = (await response.json().catch(() => null)) as {
      status?: string;
      reason?: string;
    } | null;
    if (body?.status === 'filled') return;
    if (body?.status === 'rejected') throw new Error(body.reason ?? 'that trade was refused');
  }
  throw new Error('Still confirming — your trade is queued and will appear in your wallet.');
}

export interface PlaceTradeInput {
  marketId: string;
  outcomeId: string;
  side: 'buy' | 'sell';
  /** Naira on a buy, shares on a sell. */
  amount: string;
  token: string;
  /** §2.15a's one-line why, posted to the thread with the position. */
  reason?: string;
  /** Called when the queue took the trade but has not executed it yet. */
  onQueued?: () => void;
}

export async function placeTrade({
  marketId,
  outcomeId,
  side,
  amount,
  token,
  reason,
  onQueued,
}: PlaceTradeInput): Promise<void> {
  // A retry must never double-fill (§11), and this is also what the trade is
  // polled by if the queue defers it.
  const requestId = crypto.randomUUID();

  const response = await fetch(`${API_URL}/trades`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      marketId,
      outcomeId,
      side,
      amount,
      requestId,
      ...(reason === undefined || reason.trim().length === 0 ? {} : { reason: reason.trim() }),
    }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `Trade failed (${response.status})`);
  }

  // §11: a busy market answers "accepted into queue", not "filled". That is a
  // 2xx, so a client reading only the status code closes on a trade that has
  // not happened — the balance does not move, the thread carries no take, and
  // the only thing that changed is that the screen stopped saying anything.
  const body = (await response.json().catch(() => ({}))) as { status?: string };
  if (body.status === 'queued') {
    onQueued?.();
    await waitForFill(requestId, token);
  }
}
