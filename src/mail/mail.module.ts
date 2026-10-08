import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailTransportKind, type Env } from '../config/env.validation';
import { ConsoleMailTransport } from './console-mail.transport';
import { MAIL_TRANSPORT, type MailTransport } from './mail-transport';
import { MailService } from './mail.service';
import { SmtpMailTransport } from './smtp-mail.transport';

@Module({
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): MailTransport =>
        config.getOrThrow('MAIL_TRANSPORT', { infer: true }) ===
        MailTransportKind.Smtp
          ? new SmtpMailTransport(config)
          : new ConsoleMailTransport(),
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
