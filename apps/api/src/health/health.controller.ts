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
  root(): { service: string; status: string; app: string; health: string } {
    return {
      service: 'stakeam-api',
      status: 'This is the StakeAm API, not the app.',
      app: env.WEB_ORIGIN,
      health: '/health',
    };
  }
}
