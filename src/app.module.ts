import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { EmailVerifiedGuard } from './common/guards/email-verified.guard';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { validate, type Env } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate }),
    PrismaModule,
    // In-memory counters: limits are per process. Use a shared store if you
    // run more than one instance.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 100 }],
        skipIf: () => !config.get('RATE_LIMIT_ENABLED', { infer: true }),
        // Credential endpoints are limited per client address AND target account,
        // so one attacker cannot lock out an account from other addresses' budgets.
        getTracker: (request: Record<string, any>) => {
          const body = request.body as { email?: unknown } | undefined;
          const email =
            typeof body?.email === 'string'
              ? body.email.trim().toLowerCase().slice(0, 254)
              : '';
          const ip = String(request.ip);
          return email ? `${ip}|${email}` : ip;
        },
      }),
    }),
    AuthModule,
    UsersModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Order matters: throttle first, then authenticate, then authorize.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: EmailVerifiedGuard },
  ],
})
export class AppModule {}
