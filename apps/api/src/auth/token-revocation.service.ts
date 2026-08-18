import { Global, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { env } from '../config/env';
import { logger } from '../logger';

/**
 * Revocation for stateless sessions (§2.1, security review gap 2).
 *
 * JWTs are stateless by design — that is what makes them cheap — but it also
 * means a stolen token stays valid until it expires, and "we froze the account"
 * was previously only true for the paths that re-read the account. Fifteen
 * minutes of read access to a staff console is not an acceptable answer to a
 * compromised laptop.
 *
 * Two kinds of revocation, because they answer different questions:
 *
 *   * **One token** (`revokeToken`) — logging out. The `jti` is denied for as
 *     long as that token could still be presented, and no longer: an entry
 *     outliving its token is just landfill.
 *   * **Every token for an account** (`revokeUser`) — a freeze, a password
 *     change, a support-desk "log me out everywhere". Stored as a cutoff
 *     timestamp rather than a list, so it works on tokens that were issued
 *     before anybody thought to enumerate them.
 *
 * **It fails open, deliberately.** If Redis is unreachable the guard cannot
 * know whether a token was revoked, and the choice is between refusing every
 * request on the platform and honouring a revocation window of at most one
 * token lifetime. Refusing everything turns a cache outage into a total
 * outage; the same reasoning the trade queue uses. The failure is logged at
 * error, because a revocation service that is quietly not working is worse
 * than one that is loudly not working.
 */
@Injectable()
export class TokenRevocationService implements OnModuleDestroy {
  private readonly redis: Redis | null;

  constructor() {
    try {
      this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
      this.redis.on('error', () => undefined);
    } catch {
      this.redis = null;
    }
  }

  /** Longest a token can outlive its revocation, so entries can expire. */
  private static readonly MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

  async revokeToken(jti: string, expiresAtEpochSeconds?: number): Promise<void> {
    if (this.redis === null) return;
    const ttl =
      expiresAtEpochSeconds === undefined
        ? TokenRevocationService.MAX_TOKEN_LIFETIME_SECONDS
        : Math.max(1, expiresAtEpochSeconds - Math.floor(Date.now() / 1000));
    await this.redis.set(`auth:revoked:jti:${jti}`, '1', 'EX', ttl).catch((error: unknown) => {
      logger.error({ jti, error: String(error) }, 'could not record token revocation');
    });
  }

  /** Invalidate every token issued to this account before now. */
  async revokeUser(userId: string): Promise<void> {
    if (this.redis === null) return;
    const cutoff = Math.floor(Date.now() / 1000);
    await this.redis
      .set(
        `auth:revoked:user:${userId}`,
        String(cutoff),
        'EX',
        TokenRevocationService.MAX_TOKEN_LIFETIME_SECONDS,
      )
      .catch((error: unknown) => {
        logger.error({ userId, error: String(error) }, 'could not revoke account sessions');
      });
  }

  /**
   * Whether this token has been revoked, by either route.
   *
   * `iat` is compared against the account cutoff with a one-second grace: a
   * token minted in the same second as a revocation is on the wrong side of a
   * rounding boundary, and the safe direction is to treat it as revoked.
   */
  async isRevoked(payload: { jti?: string; sub: string; iat?: number }): Promise<boolean> {
    if (this.redis === null) return false;

    try {
      const [byToken, cutoff] = await this.redis.mget(
        payload.jti === undefined ? 'auth:revoked:jti:-' : `auth:revoked:jti:${payload.jti}`,
        `auth:revoked:user:${payload.sub}`,
      );
      if (byToken !== null) return true;
      if (cutoff !== null && payload.iat !== undefined && payload.iat <= Number(cutoff))
        return true;
      return false;
    } catch (error) {
      logger.error(
        { userId: payload.sub, error: String(error) },
        'revocation check failed — allowing the request; see TokenRevocationService',
      );
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit().catch(() => undefined);
  }
}

/**
 * Global, because `JwtGuard` is applied in almost every module and a guard's
 * dependencies have to resolve wherever it is used.
 */
@Global()
@Module({
  providers: [TokenRevocationService],
  exports: [TokenRevocationService],
})
export class TokenRevocationModule {}
