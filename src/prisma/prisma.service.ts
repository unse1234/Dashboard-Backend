import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client';
import type { Env } from '../config/env.validation';
import { recordDatabaseQuery } from '../common/observability/request-timing';
import { TimedPool } from './timed-pool';

/** Either the shared client or the client handed to an interactive transaction. */
export type Db = Prisma.TransactionClient | PrismaService;

type TimedClientOptions = Prisma.PrismaClientOptions & {
  log: { emit: 'event'; level: 'query' }[];
};

/**
 * Single shared Prisma 7 client. Prisma 7 requires a driver adapter, so the
 * connection string is read from validated config and handed to `PrismaPg`.
 */
@Injectable()
export class PrismaService
  extends PrismaClient<TimedClientOptions>
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService<Env, true>) {
    super({
      adapter: new PrismaPg(
        new TimedPool({
          connectionString: config.getOrThrow('DATABASE_URL', { infer: true }),
          connectionTimeoutMillis: config.getOrThrow(
            'DB_CONNECTION_TIMEOUT_MS',
            {
              infer: true,
            },
          ),
          statement_timeout: config.getOrThrow('DB_QUERY_TIMEOUT_MS', {
            infer: true,
          }),
          // Give PostgreSQL time to report its cancellation before the driver's
          // fallback deadline handles a connection that has stopped responding.
          query_timeout:
            config.getOrThrow('DB_QUERY_TIMEOUT_MS', { infer: true }) + 1_000,
        }),
        { disposeExternalPool: true },
      ),
      log: config.getOrThrow('REQUEST_TIMING_ENABLED', { infer: true })
        ? [{ emit: 'event', level: 'query' }]
        : [],
    });
    this.$on('query', (event) => recordDatabaseQuery(event.duration));
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
