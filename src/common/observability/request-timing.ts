import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export interface RequestTiming {
  requestId: string;
  startedAt: number;
  dbQueries: number;
  dbMs: number;
  dbAcquireMs: number;
  poolWaitingMax: number;
  stages: Record<string, number>;
}

export const requestTimings = new AsyncLocalStorage<RequestTiming>();

/** Fixed operation labels only; never pass user input, SQL or credentials. */
export async function measureOperation<T>(
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  const timing = requestTimings.getStore();
  if (!timing) return operation();
  const started = performance.now();
  try {
    return await operation();
  } finally {
    timing.stages[stage] =
      (timing.stages[stage] ?? 0) + performance.now() - started;
  }
}

/**
 * Prisma emits these events for successful queries, not failed attempts.
 * Retain duration only, never SQL/params; app/stage timing also covers failures.
 */
export function recordDatabaseQuery(duration: number): void {
  const timing = requestTimings.getStore();
  if (!timing) return;
  timing.dbQueries += 1;
  timing.dbMs += duration;
}

const rounded = (duration: number) => Number(duration.toFixed(2));

function serverTiming(timing: RequestTiming): string {
  const metrics: Record<string, number> = {
    app: performance.now() - timing.startedAt,
    db: timing.dbMs,
    db_acquire: timing.dbAcquireMs,
    ...timing.stages,
  };
  return [
    ...Object.entries(metrics).map(
      ([name, duration]) =>
        `${name.replace(/[^a-zA-Z0-9_-]/g, '_')};dur=${rounded(duration)}`,
    ),
    `db_count;desc="${timing.dbQueries}"`,
  ].join(', ');
}

interface TimingOptions {
  enabled: boolean;
  slowRequestMs: number;
  allowedOrigins: ReadonlySet<string>;
  /** Injectable sink for tests; only bounded, redacted summaries reach it. */
  log?: (summary: string) => void;
}

/** Starts before guards and measures through response completion, including errors. */
export function requestTimingMiddleware(options: TimingOptions) {
  const logger = new Logger('RequestTiming');
  const log = options.log ?? ((summary: string) => logger.log(summary));
  return (request: Request, response: Response, next: NextFunction) => {
    if (!options.enabled) return next();
    const timing: RequestTiming = {
      requestId: randomUUID(),
      startedAt: performance.now(),
      dbQueries: 0,
      dbMs: 0,
      dbAcquireMs: 0,
      poolWaitingMax: 0,
      stages: {},
    };
    requestTimings.run(timing, () => {
      response.setHeader('X-Request-Id', timing.requestId);
      const origin = request.get('origin');
      if (origin && options.allowedOrigins.has(origin)) {
        response.setHeader('Timing-Allow-Origin', origin);
      }

      // finish is too late for headers; writeHead also covers Express errors
      // and streamed responses. Its argument overloads are forwarded untouched.
      const writeHead = response.writeHead.bind(response);
      response.writeHead = ((...args: unknown[]) => {
        if (!response.headersSent) {
          response.setHeader('Server-Timing', serverTiming(timing));
        }
        return Reflect.apply(writeHead, response, args) as Response;
      }) as Response['writeHead'];

      let completed = false;
      const finish = (aborted: boolean) => {
        if (completed) return;
        completed = true;
        const durationMs = performance.now() - timing.startedAt;
        if (
          !aborted &&
          response.statusCode < 500 &&
          durationMs < options.slowRequestMs
        ) {
          return;
        }
        // originalUrl/query/body may contain reset tokens or personal data.
        // Only Express's route template is suitable for a log label.
        const route = request.route as { path?: unknown } | undefined;
        log(
          JSON.stringify({
            event: 'request_timing',
            requestId: timing.requestId,
            method: request.method,
            route: typeof route?.path === 'string' ? route.path : 'unmatched',
            status: response.statusCode,
            aborted,
            durationMs: rounded(durationMs),
            dbQueries: timing.dbQueries,
            dbMs: rounded(timing.dbMs),
            dbAcquireMs: rounded(timing.dbAcquireMs),
            poolWaitingMax: timing.poolWaitingMax,
            stages: Object.fromEntries(
              Object.entries(timing.stages).map(([name, duration]) => [
                name,
                rounded(duration),
              ]),
            ),
          }),
        );
      };
      response.once('finish', () => finish(false));
      response.once('close', () => finish(!response.writableFinished));
      next();
    });
  };
}
