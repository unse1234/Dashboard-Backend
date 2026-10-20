import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { Env } from '../config/env.validation';
import type {
  MailMessage,
  MailSendResult,
  MailTransport,
} from './mail-transport';

// Bounded so that one send always ends well inside the outbox's claim lease
// (nodemailer's own defaults allow a socket to sit idle for ten minutes).
const CONNECTION_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 60_000;

/** The domain of MAIL_FROM ("Shop <no-reply@shop.example>" -> "shop.example"). */
export function senderDomain(from: string): string {
  const match = /@([A-Za-z0-9.-]+)>?\s*$/.exec(from.trim());
  return match ? match[1].toLowerCase() : 'localhost';
}

export class SmtpMailTransport implements MailTransport {
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly domain: string;

  constructor(config: ConfigService<Env, true>) {
    const user = config.get('SMTP_USER', { infer: true });
    const pass = config.get('SMTP_PASS', { infer: true });
    this.from = config.getOrThrow('MAIL_FROM', { infer: true });
    this.domain = senderDomain(this.from);
    this.transporter = createTransport({
      host: config.getOrThrow('SMTP_HOST', { infer: true }),
      port: config.getOrThrow('SMTP_PORT', { infer: true }),
      secure: config.getOrThrow('SMTP_SECURE', { infer: true }),
      auth: user && pass ? { user, pass } : undefined,
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
    });
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    const info = (await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      // SMTP has no idempotency key; a stable Message-ID is the nearest thing:
      // every retry of one email carries the same id, which mail systems use
      // to recognise duplicates.
      ...(message.idempotencyKey
        ? { messageId: `<${message.idempotencyKey}@${this.domain}>` }
        : {}),
    })) as { messageId?: unknown };
    return typeof info.messageId === 'string'
      ? { messageId: info.messageId }
      : {};
  }
}
