import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { EmailOutboxDispatcher } from './email-outbox.dispatcher';
import { EmailOutboxStore } from './email-outbox.store';
import { OrderConfirmationEmails } from './order-confirmation-emails';

/** Durable email: recorded in the caller's transaction, sent after it commits. */
@Module({
  imports: [MailModule],
  providers: [
    EmailOutboxStore,
    EmailOutboxDispatcher,
    OrderConfirmationEmails,
  ],
  exports: [
    EmailOutboxStore,
    EmailOutboxDispatcher,
    OrderConfirmationEmails,
  ],
})
export class EmailOutboxModule {}
