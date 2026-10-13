import { ValidationPipe } from '@nestjs/common';
import { BagQuoteDto, CheckoutQuoteDto } from './bag-quote.dto';
import { isDeliveryCountry } from './storefront-address.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const bag = (value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: BagQuoteDto });
const checkout = (value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: CheckoutQuoteDto });

const address = {
  recipientName: 'Ayesha Khan',
  addressLine1: 'House 12, Street 4, F-7/2',
  city: 'Islamabad',
  region: 'Islamabad Capital Territory',
  country: 'PK',
};
const items = [{ productId: 'PRD-1001', quantity: 2 }];

describe('BagQuoteDto', () => {
  it('accepts an empty bag, a bag, and a bag with an action', async () => {
    await expect(bag({ items: [] })).resolves.toMatchObject({ items: [] });
    await expect(bag({ items })).resolves.toMatchObject({ items });
    await expect(
      bag({
        items,
        action: { type: 'add', productId: 'prd-1002', quantity: 3 },
      }),
    ).resolves.toMatchObject({
      action: { type: 'add', productId: 'prd-1002', quantity: 3 },
    });
  });

  it.each([
    ['no items', {}],
    ['items that are not a list', { items: 'PRD-1001' }],
    ['a line without a quantity', { items: [{ productId: 'PRD-1001' }] }],
    ['a zero quantity', { items: [{ productId: 'PRD-1001', quantity: 0 }] }],
    [
      'a quantity over 1000',
      { items: [{ productId: 'PRD-1001', quantity: 1001 }] },
    ],
    [
      'a fractional quantity',
      { items: [{ productId: 'PRD-1001', quantity: 1.5 }] },
    ],
    [
      'a product id that is not one',
      { items: [{ productId: 'X', quantity: 1 }] },
    ],
    [
      'a price on a line',
      { items: [{ productId: 'PRD-1001', quantity: 1, price: 1 }] },
    ],
    ['a total from the client', { items, total: 1 }],
    [
      'an unknown action',
      { items, action: { type: 'clear', productId: 'PRD-1001' } },
    ],
    ['an action without a product', { items, action: { type: 'add' } }],
    [
      'an action with a bad quantity',
      { items, action: { type: 'set', productId: 'PRD-1001', quantity: 0 } },
    ],
    ['a null action', { items, action: null }],
    [
      'more than 101 lines',
      {
        items: Array.from({ length: 102 }, (_, i) => ({
          productId: `PRD-${1001 + i}`,
          quantity: 1,
        })),
      },
    ],
  ])('rejects %s', async (_label, body) => {
    await expect(bag(body)).rejects.toMatchObject({ status: 400 });
  });
});

describe('CheckoutQuoteDto', () => {
  it('accepts items and a Pakistan address', async () => {
    await expect(
      checkout({ items, shippingAddress: address }),
    ).resolves.toMatchObject({ shippingAddress: address });
  });

  it('trims, and turns blank optional fields into null', async () => {
    const result = await checkout({
      items,
      shippingAddress: {
        ...address,
        recipientName: '  Ayesha Khan ',
        addressLine2: '   ',
        postalCode: ' 44000 ',
        phone: ' 0300 1234567 ',
      },
    });
    expect(result.shippingAddress).toMatchObject({
      recipientName: 'Ayesha Khan',
      addressLine2: null,
      postalCode: '44000',
      phone: '0300 1234567',
    });
  });

  it('needs at least one line, and an address', async () => {
    await expect(
      checkout({ items: [], shippingAddress: address }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(checkout({ items })).rejects.toMatchObject({ status: 400 });
    await expect(
      checkout({ items, shippingAddress: null }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    ['no recipient', { recipientName: '' }],
    ['no street address', { addressLine1: '  ' }],
    ['no city', { city: '' }],
    ['no province', { region: '' }],
    ['no country', { country: '' }],
    ['a city over 100 characters', { city: 'c'.repeat(101) }],
    ['a region over 100 characters', { region: 'r'.repeat(101) }],
    ['a country over 100 characters', { country: 'c'.repeat(101) }],
    ['an address line over 200 characters', { addressLine1: 'a'.repeat(201) }],
    ['a recipient over 120 characters', { recipientName: 'n'.repeat(121) }],
    ['a postal code that is not five digits', { postalCode: '4400' }],
    ['a postal code with letters', { postalCode: 'SW1Y 4JH' }],
    ['a phone that is not Pakistani', { phone: '+1 415 555 0100' }],
    ['a phone with letters', { phone: 'call me' }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(
      checkout({ items, shippingAddress: { ...address, ...overrides } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses amounts, statuses and a currency the client might try to send', async () => {
    for (const extra of [
      { shipping: 0 },
      { tax: 0 },
      { discount: 100 },
      { total: 1 },
      { currency: 'USD' },
      { paymentStatus: 'PAID' },
      { customerId: 'CUS-1001' },
    ]) {
      await expect(
        checkout({ items, shippingAddress: address, ...extra }),
      ).rejects.toMatchObject({ status: 400 });
    }
  });
});

describe('isDeliveryCountry', () => {
  it.each(['PK', 'pk', ' Pk ', 'Pakistan', 'PAKISTAN'])('accepts %p', (c) => {
    expect(isDeliveryCountry(c)).toBe(true);
  });

  it.each(['US', 'India', 'PAK', 'Pakistan, Karachi', ''])(
    'refuses %p',
    (c) => {
      expect(isDeliveryCountry(c)).toBe(false);
    },
  );
});
