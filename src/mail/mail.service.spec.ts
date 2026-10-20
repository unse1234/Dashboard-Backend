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
  const configWith = (storefrontUrl?: string) =>
    ({
      getOrThrow: () => 'https://admin.example.com/',
      get: (key: string) =>
        key === 'STOREFRONT_URL' ? storefrontUrl : undefined,
    }) as unknown as ConfigService<never, true>;
  const service = new MailService(transport, configWith());

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

  describe('order confirmation', () => {
    const details = {
      orderNumber: 10042,
      customerName: 'Ada',
      currency: 'PKR' as const,
      paymentMethod: 'COD' as const,
      items: [],
      subtotal: '0.00',
      shipping: '0.00',
      tax: '0.00',
      discount: '0.00',
      total: '0.00',
      shippingAddress: {},
      expiresAt: new Date('2026-10-17T10:00:00Z'),
    };

    it('links to the storefront with the token in the fragment, never the query', () => {
      const shop = new MailService(
        transport,
        configWith('https://shop.example.com/'),
      );
      const message = shop.orderConfirmation(
        'a@example.com',
        details,
        'oc_a b',
      );
      expect(message.text).toContain(
        'https://shop.example.com/orders/confirm#token=oc_a%20b',
      );
      expect(message.text).not.toContain('?token=');
    });

    it('falls back to the frontend URL when no storefront URL is configured', () => {
      const message = service.orderConfirmation(
        'a@example.com',
        details,
        'oc_x',
      );
      expect(message.text).toContain(
        'https://admin.example.com/orders/confirm#token=oc_x',
      );
    });

    it('delivers through the transport, passing the idempotency key on', async () => {
      await expect(
        service.deliver({
          to: 'a@example.com',
          subject: 's',
          text: 't',
          idempotencyKey: 'job-1',
        }),
      ).resolves.toEqual({});
      expect(sent[0].idempotencyKey).toBe('job-1');
    });
  });

  describe('storefront account emails', () => {
    const shop = new MailService(
      transport,
      configWith('https://shop.example.com'),
    );
    const expiresAt = new Date('2026-10-17T10:00:00Z');

    it('sends setup links to the storefront setup page, token in the fragment', () => {
      const message = shop.accountSetupLink(
        'a@example.com',
        'as_x y',
        expiresAt,
      );
      expect(message).toMatchObject({
        to: 'a@example.com',
        subject: 'Set up your account',
      });
      expect(message.text).toContain(
        'https://shop.example.com/account/setup#token=as_x%20y',
      );
      expect(message.html).toContain(
        'href="https://shop.example.com/account/setup#token=as_x%20y"',
      );
      expect(message.text).toContain('17 Oct 2026, 15:00 (Pakistan time)');
      expect(message.text).not.toContain('?token=');
    });

    it('sends reset links to the storefront reset page, not the dashboard one', () => {
      const message = shop.storefrontPasswordReset(
        'a@example.com',
        'pr_x',
        expiresAt,
      );
      expect(message.subject).toBe('Reset your password');
      expect(message.text).toContain(
        'https://shop.example.com/account/reset-password#token=pr_x',
      );
      expect(message.text).not.toContain('admin.example.com');
      expect(message.text).toContain('your password stays as it is');
    });
  });
});
