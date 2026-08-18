import { Injectable } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

import { env } from '../config/env';
import { logger } from '../logger';

/**
 * Transactional email (§2.12).
 *
 * The transport is built once and only if `SMTP_URL` is set; without it the
 * sender logs and reports why, so a missing configuration shows up as a failure
 * on the notification row rather than as silence.
 */
@Injectable()
export class EmailSender {
  private transport: Transporter | null = null;

  private connection(): Transporter | null {
    if (env.SMTP_URL === undefined || env.SMTP_URL.length === 0) return null;
    this.transport ??= createTransport(env.SMTP_URL);
    return this.transport;
  }

  async send(to: string, subject: string, body: string): Promise<string | null> {
    const transport = this.connection();
    if (transport === null) {
      logger.info({ to, subject }, 'email not configured — message logged instead of sent');
      return 'SMTP_URL is not configured';
    }

    await transport.sendMail({ from: env.EMAIL_FROM, to, subject, text: body });
    return null;
  }
}
