import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JwtGuard, type RequestWithUser } from './jwt.guard';
import { TokenRevocationService } from './token-revocation.service';

/**
 * Security review gap 2, closed and pinned.
 *
 * A signature that verifies is not the same as a session that still counts.
 * These run the real guard against a real Redis, because the whole point of the
 * change is behaviour at the boundary — a mocked store would prove only that
 * the mock was called.
 */
const jwt = new JwtService({ secret: process.env['JWT_SECRET'] ?? 'x'.repeat(40) });
let revocations: TokenRevocationService;
let guard: JwtGuard;

function contextFor(token: string) {
  const request: RequestWithUser = { headers: { authorization: `Bearer ${token}` } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    request,
  };
}

beforeAll(() => {
  revocations = new TokenRevocationService();
  guard = new JwtGuard(jwt, revocations);
});

afterAll(async () => {
  await revocations.onModuleDestroy();
});

describe('token revocation', () => {
  it('lets a normal token through', async () => {
    const token = await jwt.signAsync({ sub: 'user-a', role: 'user', tier: 1, jti: 'jti-a' });
    const context = contextFor(token);
    await expect(guard.canActivate(context as never)).resolves.toBe(true);
    expect(context.request.user?.userId).toBe('user-a');
  });

  it('refuses a token that has been revoked by id — logging out ends the session', async () => {
    const token = await jwt.signAsync({ sub: 'user-b', role: 'user', tier: 1, jti: 'jti-b' });
    await revocations.revokeToken('jti-b');

    await expect(guard.canActivate(contextFor(token) as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses every token an account held when it was frozen', async () => {
    // Two separate sessions, neither of which anybody enumerated.
    const one = await jwt.signAsync({ sub: 'user-c', role: 'user', tier: 1, jti: 'jti-c1' });
    const two = await jwt.signAsync({ sub: 'user-c', role: 'user', tier: 1, jti: 'jti-c2' });

    // The cutoff is compared against `iat`, which has one-second resolution, so
    // a token minted in the same second sits on the boundary. Waiting past it
    // is what a real freeze does anyway.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await revocations.revokeUser('user-c');

    await expect(guard.canActivate(contextFor(one) as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(guard.canActivate(contextFor(two) as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('still admits tokens issued after the freeze was lifted', async () => {
    await revocations.revokeUser('user-d');
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const fresh = await jwt.signAsync({ sub: 'user-d', role: 'user', tier: 1, jti: 'jti-d2' });
    await expect(guard.canActivate(contextFor(fresh) as never)).resolves.toBe(true);
  });
});
