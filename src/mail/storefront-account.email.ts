import { escapeHtml } from './escape-html';
import type { MailMessage } from './mail-transport';
import { formatDeadline } from './order-confirmation.email';

interface AccountLinkEmail {
  subject: string;
  intro: string;
  actionLabel: string;
  link: string;
  expiresAt: Date;
  ignoreNote: string;
}

/**
 * A shopper email whose point is one single-use link. `link` is built by the
 * caller from the configured storefront address; the token appears nowhere
 * else in the message.
 */
function buildAccountLinkEmail(
  to: string,
  email: AccountLinkEmail,
): MailMessage {
  const expiry = `This link works once, until ${formatDeadline(email.expiresAt)}.`;
  const text = [
    'Hello,',
    '',
    email.intro,
    '',
    `${email.actionLabel}: ${email.link}`,
    '',
    expiry,
    '',
    email.ignoreNote,
  ].join('\n');
  const html = [
    '<p>Hello,</p>',
    `<p>${escapeHtml(email.intro)}</p>`,
    `<p><a href="${escapeHtml(email.link)}">${escapeHtml(email.actionLabel)}</a></p>`,
    `<p>${escapeHtml(expiry)}</p>`,
    `<p>${escapeHtml(email.ignoreNote)}</p>`,
  ].join('');
  return { to, subject: email.subject, text, html };
}

/** A new link to create a storefront account for an address with a confirmed order. */
export function buildAccountSetupLinkEmail(
  to: string,
  link: string,
  expiresAt: Date,
): MailMessage {
  return buildAccountLinkEmail(to, {
    subject: 'Set up your account',
    intro:
      'You asked for a link to create an account with this email address. With an account you can see your confirmed orders in one place.',
    actionLabel: 'Set up your account',
    link,
    expiresAt,
    ignoreNote:
      'If you did not ask for this, ignore this email: no account is created without the link.',
  });
}

/** A storefront account's password reset link. */
export function buildStorefrontPasswordResetEmail(
  to: string,
  link: string,
  expiresAt: Date,
): MailMessage {
  return buildAccountLinkEmail(to, {
    subject: 'Reset your password',
    intro:
      'We received a request to reset the password of the account for this email address.',
    actionLabel: 'Choose a new password',
    link,
    expiresAt,
    ignoreNote:
      'If you did not ask for this, ignore this email: your password stays as it is.',
  });
}
