import { ConfigService } from '@nestjs/config';
import type { MailMessage, MailTransport } from './mail-transport';
import { MailService } from './mail.service';

describe('MailService', () => {
  const sent: MailMessage[] = [];
  const transport: MailTransport = {
    send: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
  };
  const service = new MailService(transport, {
    getOrThrow: () => 'https://admin.example.com/',
  } as unknown as ConfigService<never, true>);

  beforeEach(() => {
    sent.length = 0;
  });

  it('builds a one-time link on the frontend origin without a double slash', async () => {
    await service.sendPasswordReset('a@example.com', 'Ada', 'tok_en-1', 30);
    expect(sent[0].to).toBe('a@example.com');
    expect(sent[0].text).toContain(
      'https://admin.example.com/reset-password?token=tok_en-1',
    );
    expect(sent[0].text).toContain('30 minutes');
    expect(sent[0].text).toContain('can be used once');
  });

  it('uses distinct pages and wording for invitations and verification', async () => {
    await service.sendInvitation('a@example.com', 'Ada', 'abc', 72);
    await service.sendEmailVerification('a@example.com', 'Ada', 'def', 24);
    expect(sent[0].text).toContain('/reset-password?token=abc');
    expect(sent[0].subject).toMatch(/invited/i);
    expect(sent[1].text).toContain('/verify-email?token=def');
    expect(sent[1].subject).toMatch(/verify/i);
  });

  it('URL-encodes tokens and HTML-escapes user-controlled names', async () => {
    await service.sendPasswordReset(
      'a@example.com',
      '<script>alert(1)</script> & "co"',
      'a b/c',
      30,
    );
    expect(sent[0].text).toContain('token=a%20b%2Fc');
    expect(sent[0].html).not.toContain('<script>');
    expect(sent[0].html).toContain('&lt;script&gt;');
    expect(sent[0].html).toContain('&amp;');
    expect(sent[0].html).toContain('&quot;co&quot;');
  });
});
