import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { CreateProductDto } from './dto/create-product.dto';
import { productCreateData } from './product-create';

const input: CreateProductDto = {
  name: 'Mug',
  sku: 'PKR-MUG',
  categoryId: 'category',
  price: 1500,
};

describe('new product currency', () => {
  it('uses PKR for both API creation and the shared CSV import path', () => {
    expect(productCreateData(input)).toMatchObject({ currency: 'PKR' });
    expect(productCreateData({ ...input, currency: 'PKR' })).toMatchObject({
      currency: 'PKR',
    });
    expect(productCreateData(input).price).toEqual(new Prisma.Decimal(1500));
  });

  it('rejects unsupported internal writes even without the HTTP validation pipe', () => {
    expect(() =>
      productCreateData({
        ...input,
        currency: 'USD',
      } as unknown as CreateProductDto),
    ).toThrow(BadRequestException);
  });
});
