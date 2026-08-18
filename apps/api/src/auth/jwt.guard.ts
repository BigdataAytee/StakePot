import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface AuthenticatedUser {
  readonly userId: string;
  readonly role: string;
  readonly tier: number;
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
}

/** Bearer-token guard. Sessions are stateless JWTs (§2.1). */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const header = request.headers['authorization'];

    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(header.slice('Bearer '.length));
      request.user = { userId: payload.sub, role: payload.role, tier: payload.tier };
      return true;
    } catch {
      throw new UnauthorizedException('invalid or expired token');
    }
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
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const header = request.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return true;

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(header.slice('Bearer '.length));
      request.user = { userId: payload.sub, role: payload.role, tier: payload.tier };
    } catch {
      // Deliberately silent: an expired token on a public page should show the
      // page, not an error.
    }
    return true;
  }
}
