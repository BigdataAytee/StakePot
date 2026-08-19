import { Injectable } from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import Redis from 'ioredis';

import { env } from '../config/env';
import { PlatformConfigService } from '../platform-config/platform-config.service';

export class OtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtpError';
  }
}

/**
 * One-time codes for contact verification (§2.1 Tier 1).
 *
 * Codes live in Redis, never in Postgres: they are short-lived by nature, and
 * a TTL is a better expiry mechanism than a cleanup job. Only a hash is stored,
 * so a Redis dump does not hand over live codes.
 */
@Injectable()
export class OtpService {
  private readonly redis: Redis;

  constructor(private readonly config: PlatformConfigService) {
    this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  }

  private static key(contact: string): string {
    return `otp:${createHash('sha256').update(contact).digest('hex')}`;
  }

  private static hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  /** Six digits from a CSPRNG — `Math.random` has no business near an auth path. */
  static generateCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  async issue(contact: string): Promise<string> {
    const ttl = await this.config.get('otp_ttl_seconds');
    const cooldown = await this.config.get('otp_resend_cooldown_seconds');
    const key = OtpService.key(contact);

    const existing = await this.redis.hget(key, 'issuedAt');
    if (existing !== null) {
      const age = Date.now() - Number(existing);
      if (age < cooldown * 1000) {
        throw new OtpError(
          `a code was already sent — try again in ${Math.ceil((cooldown * 1000 - age) / 1000)}s`,
        );
      }
    }

    const code = OtpService.generateCode();
    await this.redis
      .multi()
      .hset(key, { hash: OtpService.hash(code), attempts: '0', issuedAt: String(Date.now()) })
      .expire(key, ttl)
      .exec();

    return code;
  }

  /**
   * Throw a code away.
   *
   * For the case where the code was issued but could not be delivered: it is
   * unusable, so it must not hold the resend cooldown against the next attempt.
   */
  async revoke(contact: string): Promise<void> {
    await this.redis.del(OtpService.key(contact));
  }

  /**
   * Verify and consume. A correct code is single-use; a wrong one burns an
   * attempt, and the record is dropped once the cap is reached so a brute force
   * has to start over against a new code it cannot predict.
   */
  async verify(contact: string, code: string): Promise<boolean> {
    const key = OtpService.key(contact);
    const record = await this.redis.hgetall(key);
    if (record['hash'] === undefined) {
      throw new OtpError('no code outstanding for this contact — request a new one');
    }

    const maxAttempts = await this.config.get('otp_max_attempts');
    const attempts = Number(record['attempts'] ?? '0');
    if (attempts >= maxAttempts) {
      await this.redis.del(key);
      throw new OtpError('too many attempts — request a new code');
    }

    const expected = Buffer.from(record['hash'], 'hex');
    const actual = Buffer.from(OtpService.hash(code), 'hex');
    const matches = expected.length === actual.length && timingSafeEqual(expected, actual);

    if (!matches) {
      await this.redis.hincrby(key, 'attempts', 1);
      return false;
    }

    await this.redis.del(key);
    return true;
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
