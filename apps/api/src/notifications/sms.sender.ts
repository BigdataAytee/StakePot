import { Injectable } from '@nestjs/common';

import { TermiiSmsProvider } from '../integrations/termii';
import { env } from '../config/env';
import { logger } from '../logger';

/**
 * SMS, through the Termii client that already carries OTPs (§5.1 step 9: "a
 * thin client, no heavy SDK").
 *
 * Without a key it logs rather than pretending: a development environment that
 * silently swallows messages teaches you nothing about whether they would send.
 */
@Injectable()
export class SmsSender {
  private readonly provider = new TermiiSmsProvider();

  async send(phone: string, text: string): Promise<string | null> {
    if (env.TERMII_KEY === undefined || env.TERMII_KEY.length === 0) {
      logger.info({ phone, text }, 'sms not configured — message logged instead of sent');
      return 'TERMII_KEY is not configured';
    }
    await this.provider.send(phone, text);
    return null;
  }
}
