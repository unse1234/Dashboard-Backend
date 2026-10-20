import { diagnosticText } from '../common/redact';
import type { MailMessage } from '../mail/mail-transport';

/** What a job's type decides about a claimed job before anything is sent. */
export type EmailJobPreparation =
  /** Send this. Retries stop at `retryUntil`, when the email stops mattering. */
  | { action: 'send'; message: MailMessage; retryUntil?: Date }
  /** Not wanted any more (its order moved on). */
  | { action: 'cancel'; code: string }
  /** Can never be sent (its secrets are unreadable, its data inconsistent). */
  | { action: 'fail'; code: string; message: string };

/**
 * How long a claim on a job lasts. Longer than any one send can take (the SMTP
 * transport gives up after its own timeouts, well under this), so a lease only
 * runs out when its worker died; then another worker may take the job.
 */
export const EMAIL_JOB_LEASE_MS = 5 * 60_000;

/** Attempts a job gets unless it says otherwise (the column default). */
export const EMAIL_JOB_MAX_ATTEMPTS = 5;

/** Wait before the 2nd, 3rd, 4th and 5th attempt. */
export const EMAIL_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
] as const;

/** How many jobs one pass claims at most. */
export const EMAIL_DISPATCH_BATCH = 50;

/** The wait before the next attempt, after `attempts` attempts have failed. */
export function retryDelayMs(attempts: number): number {
  const index = Math.min(
    Math.max(attempts, 1) - 1,
    EMAIL_RETRY_DELAYS_MS.length - 1,
  );
  return EMAIL_RETRY_DELAYS_MS[index];
}

export interface SendFailure {
  /** Whether trying again later could succeed. */
  retryable: boolean;
  /** A short, stable label for the dashboard and logs. */
  code: string;
  /** Redacted and truncated; safe to store and log. */
  message: string;
}

// Network failures nodemailer reports (and Node's own socket errors).
const NETWORK_CODES = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
]);

/**
 * Sorts a transport error into "try again" or "give up". An SMTP 5xx reply is a
 * permanent refusal (bad address, rejected content); a 4xx reply, a network
 * error or anything unknown may pass on a later attempt.
 */
export function classifySendFailure(error: unknown): SendFailure {
  const details =
    error && typeof error === 'object'
      ? (error as { responseCode?: unknown; code?: unknown; message?: unknown })
      : {};
  const message = diagnosticText(
    typeof details.message === 'string'
      ? details.message
      : 'The mail transport failed',
  );
  const responseCode =
    typeof details.responseCode === 'number' ? details.responseCode : null;

  if (responseCode !== null && responseCode >= 500 && responseCode < 600) {
    return { retryable: false, code: `SMTP_${responseCode}`, message };
  }
  if (responseCode !== null && responseCode >= 400 && responseCode < 500) {
    return { retryable: true, code: `SMTP_${responseCode}`, message };
  }
  if (typeof details.code === 'string' && NETWORK_CODES.has(details.code)) {
    return { retryable: true, code: details.code, message };
  }
  return { retryable: true, code: 'SEND_FAILED', message };
}
