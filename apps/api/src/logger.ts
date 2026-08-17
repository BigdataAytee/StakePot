import pino from 'pino';
import { env } from './config/env';

/**
 * Structured logs in every environment; pino-pretty only when a human is
 * reading them. Nothing here should ever be handed a raw money amount without
 * `.toString()` — a Decimal serialises as an object otherwise.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.pwHash', '*.password'],
    censor: '[redacted]',
  },
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});
