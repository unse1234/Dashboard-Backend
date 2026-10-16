import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { parseOrigins, type Env } from './config/env.validation';
import { CSRF_HEADER } from './common/guards/csrf.guard';
import { requestTimingMiddleware } from './common/observability/request-timing';
import { UploadsService } from './uploads/uploads.service';
import { isLocalImageKey } from './uploads/image-validation';

/**
 * HTTP-level configuration shared by main.ts and the e2e tests, so tests run
 * with exactly the middleware, pipes and CORS rules that production uses.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const allowedOrigins = new Set(
    parseOrigins(config.getOrThrow('CORS_ORIGINS', { infer: true })),
  );
  app.use(
    requestTimingMiddleware({
      enabled: config.getOrThrow('REQUEST_TIMING_ENABLED', { infer: true }),
      slowRequestMs: config.getOrThrow('SLOW_REQUEST_THRESHOLD_MS', {
        infer: true,
      }),
      allowedOrigins,
    }),
  );

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

  app.enableCors({
    // Disallowed origins simply get no CORS headers; non-browser callers send no Origin.
    origin: (origin, callback) =>
      callback(null, !origin || allowedOrigins.has(origin)),
    credentials: true,
    exposedHeaders: ['Server-Timing', 'X-Request-Id'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // Idempotency-Key: the storefront's order placement (and a script's) sends it
    // from the browser, so the preflight has to allow it.
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      CSRF_HEADER,
      'Idempotency-Key',
    ],
    maxAge: 600,
  });

  // Public reads expose only generated image keys, never an index, dotfile or
  // arbitrary file placed in the storage root. Mutations still use global guards.
  const uploads = app.get(UploadsService);
  app.use('/uploads', (req: Request, res: Response, next: NextFunction) => {
    if (
      !['GET', 'HEAD'].includes(req.method) ||
      !isLocalImageKey(req.path.slice(1))
    ) {
      res.status(404).json({
        statusCode: 404,
        message: 'Image not found',
        error: 'Not Found',
      });
      return;
    }
    next();
  });
  app.useStaticAssets(uploads.rootDirectory, {
    prefix: '/uploads/',
    index: false,
    redirect: false,
    dotfiles: 'deny',
    fallthrough: false,
    setHeaders: (res: Response) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // UUID files never change. Keep URLs usable from dashboard/storefront origins.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  });
  app.use(
    '/uploads',
    (error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) {
        next(error);
        return;
      }
      const status =
        error &&
        typeof error === 'object' &&
        'statusCode' in error &&
        error.statusCode === 404
          ? 404
          : 500;
      res.status(status).json({
        statusCode: status,
        message: status === 404 ? 'Image not found' : 'Internal server error',
        error: status === 404 ? 'Not Found' : 'Internal Server Error',
      });
    },
  );
}
