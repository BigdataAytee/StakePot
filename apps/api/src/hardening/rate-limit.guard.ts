import {
  CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { RequestWithUser } from '../auth/jwt.guard';
import { RateLimitedError, RateLimitService } from './rate-limit.service';
import { exemptFromReadLimits, type LimitClass } from './rate-limits';

export const LIMIT_KEY = 'stakeam:rate-limit';

/** Declare which budget an endpoint spends from. */
export const RateLimit = (limitClass: LimitClass) => SetMetadata(LIMIT_KEY, limitClass);

/**
 * The per-endpoint half of §12's rate limiting.
 *
 * A guard rather than middleware, so the limit is declared next to the handler
 * it protects and shows up in the same place as the auth and role guards — a
 * limit written somewhere else is a limit somebody removes an endpoint from
 * without noticing.
 *
 * Runs *after* the auth guards where both are present, so an authenticated
 * caller is limited by account and not merely by address. That ordering matters
 * on a shared connection: everybody behind one NAT would otherwise share a
 * budget.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limits: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const limitClass = this.reflector.getAllAndOverride<LimitClass | undefined>(LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (limitClass === undefined) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    // Staff clicking through the admin panel legitimately outpace the read
    // budget, and locking an operator out mid-incident is worse than the
    // traffic. Never applies to trades — staff cannot trade at all (§2.7).
    if (limitClass === 'read' && user !== undefined && exemptFromReadLimits(user.role)) {
      return true;
    }

    try {
      await this.limits.consume({
        limitClass,
        ...(user === undefined ? {} : { userId: user.userId }),
        ...(request.ip === undefined ? {} : { ip: request.ip }),
      });
      return true;
    } catch (caught) {
      if (caught instanceof RateLimitedError) {
        // 429 with `Retry-After`, so a well-behaved client backs off by the
        // amount we actually want rather than by a guess.
        throw new HttpException(
          { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: caught.message },
          HttpStatus.TOO_MANY_REQUESTS,
          { cause: caught },
        );
      }
      throw caught;
    }
  }
}
