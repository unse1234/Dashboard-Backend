export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * The same for every attempt at one logical email. Transports pass it on
   * where the provider supports deduplication (SMTP: a stable Message-ID).
   */
  idempotencyKey?: string;
}

export interface MailSendResult {
  /** The provider's id for the message, when it reports one. */
  messageId?: string;
}

/** Delivery boundary: swap implementations without touching the callers. */
export interface MailTransport {
  send(message: MailMessage): Promise<MailSendResult | void>;
}

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
