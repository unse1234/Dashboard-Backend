import { Logger } from '@nestjs/common';
import type { MailMessage, MailTransport } from './mail-transport';

/**
 * Development only: prints the message (including its action link) instead of
 * sending it. Environment validation refuses this transport in production.
 */
export class ConsoleMailTransport implements MailTransport {
  private readonly logger = new Logger('ConsoleMail');

  send(message: MailMessage): Promise<void> {
    this.logger.log(
      `\n--- DEV EMAIL (not sent) ---\nTo: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n----------------------------`,
    );
    return Promise.resolve();
  }
}
