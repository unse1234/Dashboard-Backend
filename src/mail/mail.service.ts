import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { escapeHtml } from './escape-html';
import {
  MAIL_TRANSPORT,
  type MailMessage,
  type MailSendResult,
  type MailTransport,
} from './mail-transport';
import {
  buildOrderConfirmationEmail,
  type OrderConfirmationDetails,
} from './order-confirmation.email';

/** Where the storefront page that confirms an order lives. */
export const ORDER_CONFIRMATION_PATH = '/orders/confirm';

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
  private readonly storefrontUrl: string;

  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    config: ConfigService<Env, true>,
  ) {
    this.frontendUrl = config
      .getOrThrow('FRONTEND_URL', { infer: true })
      .replace(/\/+$/, '');
    // Links in shopper emails come only from configuration, never from a
    // request's Host or Origin.
    this.storefrontUrl = (
      config.get('STOREFRONT_URL', { infer: true }) ?? this.frontendUrl
    ).replace(/\/+$/, '');
  }

  /**
   * The email asking a shopper to confirm an order. The token travels in the
   * link's fragment, which browsers never send to a server, so it stays out of
   * access logs and Referer headers. Composed only: the outbox sends it.
   */
  orderConfirmation(
    to: string,
    details: OrderConfirmationDetails,
    token: string,
  ): MailMessage {
    return buildOrderConfirmationEmail(
      to,
      details,
      this.storefrontLink(ORDER_CONFIRMATION_PATH, token),
    );
  }

  /** Hands a composed message to the configured transport. */
  async deliver(message: MailMessage): Promise<MailSendResult> {
    return (await this.transport.send(message)) ?? {};
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

  /** A storefront page with the token in the fragment, never in the query. */
  private storefrontLink(path: string, token: string): string {
    return `${this.storefrontUrl}${path}#token=${encodeURIComponent(token)}`;
  }

  private link(path: string, token: string): string {
    return `${this.frontendUrl}${path}?token=${encodeURIComponent(token)}`;
  }

  private async sendAction(email: ActionEmail): Promise<void> {
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

    await this.transport.send({
      to: email.to,
      subject: email.subject,
      text,
      html,
    });
  }
}
