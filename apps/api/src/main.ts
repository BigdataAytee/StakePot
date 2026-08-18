import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import * as Sentry from '@sentry/node';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { env } from './config/env';
import { logger } from './logger';

async function bootstrap(): Promise<void> {
  if (env.SENTRY_DSN !== undefined) {
    Sentry.init({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV });
  }

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
  );

  // helmet is a connect-style middleware. Running it from Fastify's `onRequest`
  // hook against the raw req/res gets the security headers without pulling in a
  // middleware compatibility shim the manifest does not list.
  const applySecurityHeaders = helmet();
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, reply, done) => {
      applySecurityHeaders(request.raw, reply.raw, (error?: unknown) => {
        done(error instanceof Error ? error : undefined);
      });
    });

  app.enableCors({ origin: env.WEB_ORIGIN, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');

  // Share the HTTP server with socket.io rather than opening a second port.
  app.get(RealtimeGateway).attach(app.getHttpServer());
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'stakeam api listening');
}

bootstrap().catch((error: unknown) => {
  logger.fatal({ error }, 'api failed to start');
  process.exitCode = 1;
});
