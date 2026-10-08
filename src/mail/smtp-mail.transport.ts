import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { Env } from '../config/env.validation';
import type { MailMessage, MailTransport } from './mail-transport';

export class SmtpMailTransport implements MailTransport {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: ConfigService<Env, true>) {
    const user = config.get('SMTP_USER', { infer: true });
    const pass = config.get('SMTP_PASS', { infer: true });
    this.from = config.getOrThrow('MAIL_FROM', { infer: true });
    this.transporter = createTransport({
      host: config.getOrThrow('SMTP_HOST', { infer: true }),
      port: config.getOrThrow('SMTP_PORT', { infer: true }),
      secure: config.getOrThrow('SMTP_SECURE', { infer: true }),
      auth: user && pass ? { user, pass } : undefined,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}
