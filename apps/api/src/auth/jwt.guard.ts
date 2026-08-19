import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { TokenRevocationService } from './token-revocation.service';

export interface AuthenticatedUser {
  readonly userId: string;
  readonly role: string;
  readonly tier: number;
  /**
   * The token's own id (§2.18).
   *
   * Carried so a screen can say which session is *this* one, and so "log out
   * everywhere else" can spare it. Optional because tokens issued before
   * sessions were recorded do not carry one, and those people must not be
   * locked out at deploy time.
   */
  readonly jti?: string;
}

/**
 * Just enough of the request for the guard. Typed structurally rather than
 * imported from fastify, which is a transitive dependency of the platform
 * adapter and not one the manifest lists directly.
 */
export interface RequestWithUser {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
  /** Fastify's resolved client address — §2.11 wants it on every admin action. */
  ip?: string;
}

interface JwtPayload {
  sub: string;
  role: string;
  tier: number;
  /** Token id, for single-session revocation. */
  jti?: string;
  /** Issued-at, for account-wide revocation cutoffs. */
  iat?: number;
}

/** Bearer-token guard. Sessions are stateless JWTs (§2.1). */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly revocations: TokenRevocationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const header = request.headers['authorization'];

    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(header.slice('Bearer '.length));
    } catch {
      throw new UnauthorizedException('invalid or expired token');
    }

    // A signature that verifies is not the same as a session that still counts:
    // logging out, a freeze, or a password change all end sessions early.
    if (await this.revocations.isRevoked(payload)) {
      throw new UnauthorizedException('this session has ended — sign in again');
    }

    request.user = {
      userId: payload.sub,
      role: payload.role,
      tier: payload.tier,
      ...(payload.jti === undefined ? {} : { jti: payload.jti }),
    };
    return true;
  }
}

/**
 * The same guard, for reads that are public but nicer when signed in.
 *
 * A creator profile is a public record and must render for somebody with no
 * account; the only thing a token adds is whether the viewer already follows
 * them. So a missing or broken token is not an error here — it just means no
 * viewer, and a bad token is treated exactly like none rather than as an
 * attack, because the endpoint reveals nothing either way.
 */
@Injectable()
export class OptionalJwtGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly revocations: TokenRevocationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const header = request.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return true;

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(header.slice('Bearer '.length));
      // A revoked token is treated as no token, not as an error — same as an
      // expired one, for the same reason.
      if (!(await this.revocations.isRevoked(payload))) {
        request.user = {
          userId: payload.sub,
          role: payload.role,
          tier: payload.tier,
          ...(payload.jti === undefined ? {} : { jti: payload.jti }),
        };
      }
    } catch {
      // Deliberately silent: an expired token on a public page should show the
      // page, not an error.
    }
    return true;
  }
}
