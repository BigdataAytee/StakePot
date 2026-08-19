import { Controller, Get } from '@nestjs/common';

import { env } from '../config/env';

@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok'; service: string } {
    return { status: 'ok', service: 'stakeam-api' };
  }
}

/**
 * Something to find at the root.
 *
 * A JSON API has no business serving a page at `/`, but somebody typing the
 * service's address into a browser — which is the first thing anyone does with
 * a fresh deploy — met `{"message":"Cannot GET /","statusCode":404}`. That is
 * indistinguishable from a broken deployment, and the reflex it produces is to
 * start debugging a service that is working perfectly.
 *
 * So: say what this is, where the app lives, and where to check whether it is
 * healthy. No version, no build id, no route list — an unauthenticated endpoint
 * on a money platform should describe itself and nothing else.
 */
@Controller()
export class RootController {
  @Get()
  root(): { service: string; status: string; app: string; health: string; commit: string } {
    return {
      service: 'stakeam-api',
      status: 'This is the StakeAm API, not the app.',
      app: env.WEB_ORIGIN,
      health: '/health',
      // Which build is actually answering. "The fix is not live" and "the fix
      // did not work" look identical from outside, and telling them apart meant
      // guessing from which responses had changed. Render sets
      // RENDER_GIT_COMMIT on every deploy; a bare commit id names the tree
      // without describing anything about it.
      commit: commitId(),
    };
  }
}

/** The deployed commit, or an honest admission that nothing said. */
function commitId(): string {
  const commit = process.env['RENDER_GIT_COMMIT'] ?? process.env['GIT_COMMIT'] ?? '';
  return commit.length === 0 ? 'unknown' : commit.slice(0, 7);
}
