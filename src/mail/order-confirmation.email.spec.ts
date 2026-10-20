import {
  addressLines,
  buildOrderConfirmationEmail,
  formatDeadline,
  formatOrderAmount,
  type OrderConfirmationDetails,
} from './order-confirmation.email';

const LINK = 'https://shop.example/orders/confirm#token=oc_abc';

const details = (
  overrides: Partial<OrderConfirmationDetails> = {},
): OrderConfirmationDetails => ({
  orderNumber: 10042,
  customerName: 'Ada Lovelace',
  currency: 'PKR',
  paymentMethod: 'COD',
  items: [
    {
      productName: 'iPhone 11',
      quantity: 2,
      unitPrice: '89999.00',
      total: '179998.00',
    },
    { productName: 'Case', quantity: 1, unitPrice: '1500', total: '1500' },
  ],
  subtotal: '181498.00',
  shipping: '0.00',
  tax: '0.00',
  discount: '0.00',
  total: '181498.00',
  shippingAddress: {
    recipientName: 'Ada Lovelace',
    phone: '0300 1234567',
    addressLine1: '1 Mall Road',
    addressLine2: null,
    city: 'Lahore',
    region: 'Punjab',
    postalCode: '54000',
    country: 'PK',
  },
  // 15:05 in Karachi (UTC+5).
  expiresAt: new Date('2026-10-17T10:05:00Z'),
  ...overrides,
});

describe('order confirmation email', () => {
  it('formats amounts in the order currency, as the storefront does', () => {
    expect(formatOrderAmount('181498', 'PKR')).toBe('Rs 181,498.00');
    expect(formatOrderAmount('12.5', 'USD')).toBe('$12.50');
  });

  it('gives the deadline in Pakistan time', () => {
    expect(formatDeadline(new Date('2026-10-17T10:05:00Z'))).toBe(
      '17 Oct 2026, 15:05 (Pakistan time)',
    );
  });

  it('reads the address snapshot defensively', () => {
    expect(addressLines(details().shippingAddress)).toEqual({
      lines: [
        'Ada Lovelace',
        '1 Mall Road',
        'Lahore, Punjab 54000',
        'Pakistan',
      ],
      phone: '0300 1234567',
    });
    expect(addressLines(null)).toEqual({ lines: [], phone: null });
    expect(addressLines({ city: 42, country: 'AE' })).toEqual({
      lines: ['AE'],
      phone: null,
    });
  });

  it('says what was ordered, what it costs, where it goes, how it is paid and by when to confirm', () => {
    const message = buildOrderConfirmationEmail(
      'ada@example.com',
      details(),
      LINK,
    );
    expect(message.to).toBe('ada@example.com');
    expect(message.subject).toBe('Confirm your order ORD-10042');
    for (const part of [
      'Hi Ada Lovelace,',
      `Confirm your order: ${LINK}`,
      'Confirm by 17 Oct 2026, 15:05 (Pakistan time).',
      'iPhone 11 x 2 at Rs 89,999.00 = Rs 179,998.00',
      'Case x 1 at Rs 1,500.00 = Rs 1,500.00',
      'Subtotal: Rs 181,498.00',
      'Shipping: Rs 0.00',
      'Total: Rs 181,498.00',
      'Lahore, Punjab 54000',
      'Phone: 0300 1234567',
      'Payment: cash on delivery. Pay Rs 181,498.00 in cash when your order arrives; nothing is charged now.',
      'If you did not place this order, ignore this email',
    ]) {
      expect(message.text).toContain(part);
    }
    expect(message.text).not.toContain('Discount');
    expect(message.html).toContain(`<a href="${LINK}">Confirm your order</a>`);
  });

  it('shows a discount only when there is one, and no cash note for other methods', () => {
    const message = buildOrderConfirmationEmail(
      'ada@example.com',
      details({ discount: '100', paymentMethod: null }),
      LINK,
    );
    expect(message.text).toContain('Discount: -Rs 100.00');
    expect(message.text).not.toContain('cash on delivery');
  });

  it('escapes everything the shopper typed in the HTML part', () => {
    const message = buildOrderConfirmationEmail(
      'ada@example.com',
      details({
        customerName: '<script>alert(1)</script>',
        items: [
          { productName: 'A & "B"', quantity: 1, unitPrice: '1', total: '1' },
        ],
        shippingAddress: {
          addressLine1: '<img src=x onerror=alert(1)>',
          country: 'PK',
        },
      }),
      LINK,
    );
    expect(message.html).not.toContain('<script>');
    expect(message.html).not.toContain('<img');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.html).toContain('A &amp; &quot;B&quot;');
  });
});
