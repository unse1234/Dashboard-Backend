export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Delivery boundary: swap implementations without touching the callers. */
export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
