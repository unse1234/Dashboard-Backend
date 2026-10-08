import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { Env } from '../config/env.validation';
import { MailModule } from '../mail/mail.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { RecoveryService } from './recovery.service';
import { RefreshCookieService } from './refresh-cookie.service';
import { SessionsService } from './sessions.service';
import { TokenService } from './token.service';

@Module({
  imports: [
    MailModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.getOrThrow('JWT_ACCESS_SECRET', { infer: true }),
        signOptions: {
          algorithm: 'HS256',
          expiresIn: config.getOrThrow('JWT_ACCESS_TTL_SECONDS', {
            infer: true,
          }),
          issuer: config.getOrThrow('JWT_ISSUER', { infer: true }),
          audience: config.getOrThrow('JWT_AUDIENCE', { infer: true }),
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    RecoveryService,
    RefreshCookieService,
    SessionsService,
    TokenService,
  ],
  // Exported for the global guards registered in AppModule and for UsersModule.
  exports: [PasswordService, RecoveryService, SessionsService, TokenService],
})
export class AuthModule {}
