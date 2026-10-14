import { ValidationPipe } from '@nestjs/common';
import { PlaceOrderDto } from './place-order.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const place = (value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: PlaceOrderDto });

const valid = {
  contact: {
    name: 'Ayesha Khan',
    email: 'Ayesha@Example.COM ',
    phone: '0300 1234567',
  },
  items: [{ productId: 'PRD-1001', quantity: 2 }],
  shippingAddress: {
    recipientName: 'Ayesha Khan',
    addressLine1: 'House 12, Street 4, F-7/2',
    city: 'Islamabad',
    region: 'Islamabad Capital Territory',
    country: 'PK',
  },
  quoteToken: 'abc.def',
};

describe('PlaceOrderDto', () => {
  it('accepts an order, lower-casing the email and keeping the phone as typed', async () => {
    const dto = (await place(valid)) as PlaceOrderDto;
    expect(dto.contact.email).toBe('ayesha@example.com');
    expect(dto.contact.phone).toBe('0300 1234567');
  });

  it.each([
    ['a customer id', { customerId: 'CUS-1001' }],
    ['a total', { total: 1 }],
    ['a subtotal', { subtotal: 1 }],
    ['shipping', { shipping: 0 }],
    ['tax', { tax: 0 }],
    ['a discount', { discount: 0 }],
    ['a currency', { currency: 'USD' }],
    ['a status', { status: 'DELIVERED' }],
    ['a payment status', { paymentStatus: 'PAID' }],
    ['a payment method', { paymentMethod: 'COD' }],
    ['card fields', { card: { number: '4242424242424242' } }],
    ['a billing address', { billingAddress: valid.shippingAddress }],
    ['an actor', { actorId: 'x' }],
    ['an idempotency key in the body', { idempotencyKey: 'abcdefgh' }],
  ])('refuses %s', async (_name, extra) => {
    await expect(place({ ...valid, ...extra })).rejects.toThrow();
  });

  it('refuses a price on a line', async () => {
    await expect(
      place({
        ...valid,
        items: [{ productId: 'PRD-1001', quantity: 1, unitPrice: 1 }],
      }),
    ).rejects.toThrow();
  });

  it.each([
    ['no contact', { contact: undefined }],
    ['a null contact', { contact: null }],
    ['no email', { contact: { ...valid.contact, email: undefined } }],
    ['an email that is not one', { contact: { ...valid.contact, email: 'x' } }],
    ['no phone', { contact: { ...valid.contact, phone: undefined } }],
    [
      'a phone that is not Pakistani',
      { contact: { ...valid.contact, phone: '+1 202 555 0147' } },
    ],
    ['no items', { items: [] }],
    ['no address', { shippingAddress: undefined }],
    [
      'a region left out',
      { shippingAddress: { ...valid.shippingAddress, region: undefined } },
    ],
    ['no quote token', { quoteToken: undefined }],
    ['an empty quote token', { quoteToken: '' }],
  ])('refuses %s', async (_name, override) => {
    await expect(place({ ...valid, ...override })).rejects.toThrow();
  });
});
