import { env } from '../config/env';
import { IntegrationError } from './errors';
import type { SmsDispatch, SmsProvider } from './types';

/**
 * Termii SMS — a thin REST client, deliberately not an SDK.
 *
 * OTP delivery is the one integration that works today, so it is real code
 * rather than a stub. Kept to `fetch` and two types: the surface is small
 * enough that a dependency would cost more than it saves.
 */

interface TermiiSendResponse {
  readonly message_id?: string;
  readonly message?: string;
  readonly code?: string;
}

export class TermiiSmsProvider implements SmsProvider {
  readonly name = 'termii';

  constructor(
    private readonly apiKey: string | undefined = env.TERMII_KEY,
    private readonly senderId: string = env.TERMII_SENDER_ID,
    private readonly baseUrl: string = env.TERMII_BASE_URL,
  ) {}

  async sendOtp(phone: string, code: string): Promise<SmsDispatch> {
    if (this.apiKey === undefined || this.apiKey.length === 0) {
      throw new IntegrationError('TERMII_KEY is not configured', this.name);
    }

    const response = await fetch(`${this.baseUrl}/api/sms/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: phone,
        from: this.senderId,
        sms: `${code} is your StakeAm code. It expires in 10 minutes. Never share it.`,
        type: 'plain',
        channel: 'generic',
        api_key: this.apiKey,
      }),
    });

    if (!response.ok) {
      throw new IntegrationError(`termii responded ${response.status}`, this.name, response.status);
    }

    const body = (await response.json()) as TermiiSendResponse;
    if (body.message_id === undefined) {
      throw new IntegrationError(
        `termii accepted the request but returned no message_id (${body.message ?? 'no message'})`,
        this.name,
        response.status,
      );
    }

    return { messageId: body.message_id };
  }
}
