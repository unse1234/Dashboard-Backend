import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { diagnosticText } from '../common/redact';
import { EMAIL_DISPATCH_BATCH } from '../email-outbox/email-outbox.policy';
import {
  EmailOutboxDispatcher,
  type DispatchSummary,
} from '../email-outbox/email-outbox.dispatcher';
import { OrderExpiryService } from '../orders/order-expiry.service';
import { PrismaService } from '../prisma/prisma.service';
import { purgeExpiredRecords } from '../storefront-tokens/retention';

/** Passes per run, so one run stays short even with a backlog. */
const MAX_PASSES = 5;

/**
 * The scheduled run (a Render Cron Job every few minutes, or any scheduler):
 * expires orders nobody confirmed in time (returning their stock), then sends
 * due emails from the outbox, and exits. Expiry goes first, so the emails of
 * orders that just expired are cancelled rather than sent. Safe to overlap
 * with requests and with another run. Last, it purges tokens, finished
 * email jobs and ended sessions past their retention (see retention.ts).
 */
async function main() {
  const context = await NestFactory.createApplicationContext(AppModule, {
    // 'log' too: in development the console mail transport prints the email
    // (and its link) at that level.
    logger: ['log', 'error', 'warn'],
  });
  try {
    const expired = await context.get(OrderExpiryService).expireOverdue();
    const dispatcher = context.get(EmailOutboxDispatcher);
    const passes: DispatchSummary[] = [];
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const summary = await dispatcher.dispatchDue();
      passes.push(summary);
      if (summary.claimed < EMAIL_DISPATCH_BATCH) break;
    }
    const total = passes.reduce((sum, s) => ({
      claimed: sum.claimed + s.claimed,
      sent: sum.sent + s.sent,
      retrying: sum.retrying + s.retrying,
      failed: sum.failed + s.failed,
      cancelled: sum.cancelled + s.cancelled,
      leaseLost: sum.leaseLost + s.leaseLost,
      abandoned: sum.abandoned + s.abandoned,
    }));
    const purged = await purgeExpiredRecords(context.get(PrismaService));
    process.stdout.write(
      `${JSON.stringify({ ordersExpired: expired, emails: total, purged })}\n`,
    );
  } finally {
    await context.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Scheduled jobs failed: ${diagnosticText(error instanceof Error ? error.message : 'Unknown error')}\n`,
  );
  process.exitCode = 1;
});
