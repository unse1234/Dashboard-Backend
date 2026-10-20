import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { diagnosticText } from '../common/redact';
import { MailService } from '../mail/mail.service';
import {
  classifySendFailure,
  EMAIL_DISPATCH_BATCH,
  retryDelayMs,
  type EmailJobPreparation,
  type SendFailure,
} from './email-outbox.policy';
import { EmailOutboxStore, type ClaimedEmailJob } from './email-outbox.store';
import { OrderConfirmationEmails } from './order-confirmation-emails';
import { StorefrontAccountEmails } from './storefront-account-emails';

export type DispatchOutcome =
  | 'sent'
  | 'retrying'
  | 'failed'
  | 'cancelled'
  /** Sent, but the job had meanwhile been cancelled or taken over. */
  | 'lease_lost';

export interface DispatchSummary {
  claimed: number;
  sent: number;
  retrying: number;
  failed: number;
  cancelled: number;
  leaseLost: number;
  /** Jobs failed because their last attempt never reported back. */
  abandoned: number;
}

/**
 * Sends what the outbox holds. Any number of these may run at once (requests
 * after commit, the scheduled run, several instances): claims are disjoint and
 * every write about a job is conditional on the claim's lease.
 *
 * Nothing here is what makes an email go out eventually: the job row is. A
 * dispatch that never happens (the process stops, the host sleeps) leaves the
 * job pending for the next scheduled run.
 */
@Injectable()
export class EmailOutboxDispatcher implements OnModuleDestroy {
  private readonly logger = new Logger('EmailOutbox');
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly store: EmailOutboxStore,
    private readonly mail: MailService,
    private readonly orderConfirmations: OrderConfirmationEmails,
    private readonly accountEmails: StorefrontAccountEmails,
  ) {}

  /** One bounded pass over due jobs: what the scheduled run calls. */
  async dispatchDue(limit = EMAIL_DISPATCH_BATCH): Promise<DispatchSummary> {
    const abandoned = await this.store.reapAbandoned();
    const jobs = await this.store.claim({ limit });
    const summary: DispatchSummary = {
      claimed: jobs.length,
      sent: 0,
      retrying: 0,
      failed: 0,
      cancelled: 0,
      leaseLost: 0,
      abandoned,
    };
    for (const job of jobs) {
      const outcome = await this.process(job);
      if (outcome === 'lease_lost') summary.leaseLost += 1;
      else summary[outcome] += 1;
    }
    return summary;
  }

  /** Sends one job now if it is due and nobody else holds it; null otherwise. */
  async dispatchJob(id: string): Promise<DispatchOutcome | null> {
    const [job] = await this.store.claim({ limit: 1, id });
    return job ? this.process(job) : null;
  }

  /**
   * Starts sending a job that a transaction has just committed, without making
   * the request wait for the mail server. The attempt is tracked: shutdown
   * waits for it, and a failure is logged (redacted) and left to the retry
   * schedule. Call it only after the commit, never inside the transaction.
   */
  dispatchAfterCommit(id: string): void {
    const attempt = this.dispatchJob(id)
      .catch((error: unknown) => {
        this.logger.warn(
          `Email job ${id}: immediate dispatch failed; the scheduled run will retry (${diagnosticText(
            error instanceof Error ? error.message : String(error),
          )})`,
        );
      })
      .finally(() => this.inFlight.delete(attempt));
    this.inFlight.add(attempt);
  }

  /**
   * Lets sends already under way finish (and record their outcome) before the
   * app stops. onModuleDestroy, not onApplicationShutdown: Nest destroys a
   * module before the modules it depends on, so the database connection is
   * still open here, and is closed by the time shutdown hooks run.
   */
  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  private async process(job: ClaimedEmailJob): Promise<DispatchOutcome> {
    let preparation: EmailJobPreparation;
    try {
      preparation = await this.prepare(job);
    } catch (error) {
      // Reading the job's data failed (the database, most likely): try again.
      return this.failAttempt(job, {
        retryable: true,
        code: 'PREPARE_FAILED',
        message: diagnosticText(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }

    if (preparation.action === 'cancel') {
      await this.store.markCancelled(job, preparation.code);
      this.logger.log(`Email job ${job.id} cancelled: ${preparation.code}`);
      return 'cancelled';
    }
    if (preparation.action === 'fail') {
      const failure = {
        retryable: false,
        code: preparation.code,
        message: diagnosticText(preparation.message),
      };
      await this.store.markFailed(job, failure);
      this.logger.error(`Email job ${job.id} failed: ${failure.code}`);
      return 'failed';
    }

    let providerMessageId: string | null;
    try {
      const result = await this.mail.deliver({
        ...preparation.message,
        // The same for every attempt at this email, so a provider that
        // deduplicates by it (or an inbox that does by Message-ID) shows one.
        idempotencyKey: job.id,
      });
      providerMessageId = result.messageId ?? null;
    } catch (error) {
      return this.failAttempt(
        job,
        classifySendFailure(error),
        preparation.retryUntil,
      );
    }

    if (!(await this.store.markSent(job, providerMessageId))) {
      this.logger.warn(
        `Email job ${job.id} was sent after its claim was lost (cancelled or taken over)`,
      );
      return 'lease_lost';
    }
    return 'sent';
  }

  private prepare(job: ClaimedEmailJob): Promise<EmailJobPreparation> {
    switch (job.type) {
      case 'ORDER_CONFIRMATION':
        return this.orderConfirmations.prepare(job);
      case 'ACCOUNT_SETUP_LINK':
      case 'STOREFRONT_PASSWORD_RESET':
        return this.accountEmails.prepare({ ...job, type: job.type });
    }
  }

  private async failAttempt(
    job: ClaimedEmailJob,
    failure: SendFailure,
    retryUntil?: Date,
  ): Promise<DispatchOutcome> {
    const nextAttemptAt = new Date(Date.now() + retryDelayMs(job.attempts));
    const canRetry =
      failure.retryable &&
      job.attempts < job.maxAttempts &&
      (!retryUntil || nextAttemptAt < retryUntil);

    if (canRetry) {
      await this.store.markRetry(job, failure, nextAttemptAt);
      this.logger.warn(
        `Email job ${job.id} attempt ${job.attempts}/${job.maxAttempts} failed (${failure.code}); retrying at ${nextAttemptAt.toISOString()}`,
      );
      return 'retrying';
    }
    await this.store.markFailed(job, failure);
    this.logger.error(
      `Email job ${job.id} gave up after attempt ${job.attempts}/${job.maxAttempts} (${failure.code})`,
    );
    return 'failed';
  }
}
