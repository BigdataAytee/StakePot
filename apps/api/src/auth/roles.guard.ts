import {
  CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@prisma/client';

import type { RequestWithUser } from './jwt.guard';

export const ROLES_KEY = 'stakeam:roles';

/**
 * §6.11's role → screen matrix, as a decorator.
 *
 * "Support staff can read tickets but not the ledger; resolvers can resolve but
 * not adjust balances" (§2.11). Written on the handler rather than checked in
 * its body, so a new endpoint that forgets to say who may call it is an
 * endpoint nobody may call — the guard denies anything it has no rule for.
 */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/** Everyone who works here. Used where a screen is staff-only in general. */
export const STAFF_ROLES: readonly UserRole[] = [
  'support',
  'resolver',
  'trust_safety',
  'finance',
  'admin',
];

/** Who may be one of the two eyes on a money movement (§6.4b). */
export const MONEY_ROLES: readonly UserRole[] = ['finance', 'admin'];

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
    if (user === undefined) {
      throw new UnauthorizedException('this endpoint needs an authenticated user');
    }

    if (!required.includes(user.role as UserRole)) {
      throw new ForbiddenException(
        `this action needs one of: ${required.join(', ')} — you are ${user.role}`,
      );
    }
    return true;
  }
}
