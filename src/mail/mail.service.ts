import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { MAIL_TRANSPORT, type MailTransport } from './mail-transport';

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ] as string,
  );

interface ActionEmail {
  to: string;
  name: string;
  subject: string;
  intro: string;
  actionLabel: string;
  url: string;
  expiry: string;
}

/** Builds the transactional emails; delivery is delegated to the configured transport. */
@Injectable()
export class MailService {
  private readonly frontendUrl: string;

  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    config: ConfigService<Env, true>,
  ) {
    this.frontendUrl = config
      .getOrThrow('FRONTEND_URL', { infer: true })
      .replace(/\/+$/, '');
  }

  sendInvitation(
    to: string,
    name: string,
    token: string,
    ttlHours: number,
  ): Promise<void> {
    return this.sendAction({
      to,
      name,
      subject: 'You have been invited to the Ecom Dash admin',
      intro:
        'An administrator created an account for you. Set your password to activate it.',
      actionLabel: 'Set your password',
      url: this.link('/reset-password', token),
      expiry: `${ttlHours} hours`,
    });
  }

  sendPasswordReset(
    to: string,
    name: string,
    token: string,
    ttlMinutes: number,
  ): Promise<void> {
    return this.sendAction({
      to,
      name,
      subject: 'Reset your Ecom Dash password',
      intro:
        'We received a request to reset your password. If this was not you, you can ignore this email.',
      actionLabel: 'Reset password',
      url: this.link('/reset-password', token),
      expiry: `${ttlMinutes} minutes`,
    });
  }

  sendEmailVerification(
    to: string,
    name: string,
    token: string,
    ttlHours: number,
  ): Promise<void> {
    return this.sendAction({
      to,
      name,
      subject: 'Verify your Ecom Dash email address',
      intro: 'Confirm that this email address belongs to you.',
      actionLabel: 'Verify email',
      url: this.link('/verify-email', token),
      expiry: `${ttlHours} hours`,
    });
  }

  private link(path: string, token: string): string {
    return `${this.frontendUrl}${path}?token=${encodeURIComponent(token)}`;
  }

  private sendAction(email: ActionEmail): Promise<void> {
    const text = [
      `Hi ${email.name},`,
      '',
      email.intro,
      '',
      `${email.actionLabel}: ${email.url}`,
      '',
      `This link expires in ${email.expiry} and can be used once.`,
    ].join('\n');

    const html =
      `<p>Hi ${escapeHtml(email.name)},</p><p>${escapeHtml(email.intro)}</p>` +
      `<p><a href="${escapeHtml(email.url)}">${escapeHtml(email.actionLabel)}</a></p>` +
      `<p>This link expires in ${escapeHtml(email.expiry)} and can be used once.</p>`;

    return this.transport.send({
      to: email.to,
      subject: email.subject,
      text,
      html,
    });
  }
}
