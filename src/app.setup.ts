import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { parseOrigins, type Env } from './config/env.validation';
import { CSRF_HEADER } from './common/guards/csrf.guard';

/**
 * HTTP-level configuration shared by main.ts and the e2e tests, so tests run
 * with exactly the middleware, pipes and CORS rules that production uses.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // Behind a reverse proxy, trust exactly N hops so req.ip (used for rate
  // limiting and session metadata) is the client address and cannot be spoofed.
  const proxyHops = config.getOrThrow('TRUST_PROXY', { infer: true });
  app.set('trust proxy', proxyHops > 0 ? proxyHops : false);

  app.use(helmet());
  app.use(cookieParser());
  app.use((_request: Request, response: Response, next: NextFunction) => {
    // Auth responses carry tokens and personal data; never let caches keep them.
    response.set('Cache-Control', 'no-store');
    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const allowedOrigins = new Set(
    parseOrigins(config.getOrThrow('CORS_ORIGINS', { infer: true })),
  );
  app.enableCors({
    // Disallowed origins simply get no CORS headers; non-browser callers send no Origin.
    origin: (origin, callback) =>
      callback(null, !origin || allowedOrigins.has(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', CSRF_HEADER],
    maxAge: 600,
  });
}
