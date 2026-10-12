import { ValidationPipe } from '@nestjs/common';
import { ArchiveProductsDto } from './archive-products.dto';
import { CreateProductDto } from './create-product.dto';
import { ListProductsQueryDto } from './list-products-query.dto';
import { UpdateProductDto } from './update-product.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const CATEGORY = '0b6c1f2e-7d6c-4f55-9d35-0d3c8e0b1a11';

const query = (value: unknown) =>
  pipe.transform(value, { type: 'query', metatype: ListProductsQueryDto });
const create = (value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: CreateProductDto });
const update = (value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: UpdateProductDto });
const archive = (value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: ArchiveProductsDto });

const valid = {
  name: 'Ceramic Mug',
  sku: 'MUG-001',
  categoryId: CATEGORY,
  price: 12.5,
};

describe('ListProductsQueryDto', () => {
  it('defaults to the first page of 20 with no filters', async () => {
    await expect(query({})).resolves.toEqual({ page: 1, pageSize: 20 });
  });

  it('converts query strings and trims the search', async () => {
    await expect(
      query({
        page: '2',
        pageSize: '100',
        search: '  mug  ',
        categoryId: CATEGORY,
        status: 'OUT_OF_STOCK',
      }),
    ).resolves.toEqual({
      page: 2,
      pageSize: 100,
      search: 'mug',
      categoryId: CATEGORY,
      status: 'OUT_OF_STOCK',
    });
  });

  it.each(['ACTIVE', 'INACTIVE', 'OUT_OF_STOCK'])(
    'accepts status=%s',
    async (status) => {
      await expect(query({ status })).resolves.toMatchObject({ status });
    },
  );

  it.each([
    ['page 0', { page: '0' }],
    ['a fractional page', { page: '1.5' }],
    ['pageSize 0', { pageSize: '0' }],
    ['pageSize over 100', { pageSize: '101' }],
    ['a search over 100 characters', { search: 'a'.repeat(101) }],
    ['a category that is not a uuid', { categoryId: 'PRD-1' }],
    ['a status in the wrong case', { status: 'active' }],
    ['the dashboard spelling of out of stock', { status: 'out-of-stock' }],
    ['an unknown status', { status: 'ARCHIVED' }],
    ['an unknown parameter', { sortBy: 'price' }],
  ])('rejects %s', async (_label, value) => {
    await expect(query(value)).rejects.toMatchObject({ status: 400 });
  });
});

describe('CreateProductDto', () => {
  it('accepts the required fields alone', async () => {
    await expect(create(valid)).resolves.toEqual(valid);
  });

  it('trims text and turns blank optional text into null', async () => {
    await expect(
      create({
        ...valid,
        name: '  Ceramic Mug  ',
        sku: '  MUG-001  ',
        brand: '   ',
        description: '  Holds 350 ml.  ',
      }),
    ).resolves.toMatchObject({
      name: 'Ceramic Mug',
      sku: 'MUG-001',
      brand: null,
      description: 'Holds 350 ml.',
    });
  });

  it('accepts every optional field', async () => {
    await expect(
      create({
        ...valid,
        brand: 'Hearthstone',
        description: 'Holds 350 ml.',
        status: 'INACTIVE',
        costPrice: 4.25,
        stock: 12,
      }),
    ).resolves.toMatchObject({
      status: 'INACTIVE',
      costPrice: 4.25,
      stock: 12,
    });
  });

  it('accepts the limits of price, cost price and stock', async () => {
    await expect(
      create({ ...valid, price: 0, costPrice: 0, stock: 0 }),
    ).resolves.toBeDefined();
    await expect(
      create({
        ...valid,
        price: 1_000_000,
        costPrice: 1_000_000,
        stock: 1_000_000,
      }),
    ).resolves.toBeDefined();
  });

  it('accepts a null cost price', async () => {
    await expect(create({ ...valid, costPrice: null })).resolves.toMatchObject({
      costPrice: null,
    });
  });

  it.each([
    ['a missing name', { name: undefined }],
    ['a one-character name', { name: 'A' }],
    ['a name over 120 characters', { name: 'a'.repeat(121) }],
    ['a whitespace-only name', { name: '   ' }],
    ['a missing SKU', { sku: undefined }],
    ['a blank SKU', { sku: '  ' }],
    ['a SKU with a space', { sku: 'MUG 001' }],
    ['a SKU over 64 characters', { sku: 'S'.repeat(65) }],
    ['a brand over 80 characters', { brand: 'b'.repeat(81) }],
    ['a description over 2000 characters', { description: 'd'.repeat(2001) }],
    ['a missing category', { categoryId: undefined }],
    ['a category that is not a uuid', { categoryId: 'Electronics' }],
    ['a status that is not allowed', { status: 'ARCHIVED' }],
    ['a lower-case status', { status: 'active' }],
    ['a missing price', { price: undefined }],
    ['a negative price', { price: -0.01 }],
    ['a price over 1,000,000', { price: 1_000_000.01 }],
    ['a price with three decimals', { price: 1.005 }],
    ['a price sent as text', { price: '12.50' }],
    ['a negative cost price', { costPrice: -1 }],
    ['a negative stock', { stock: -1 }],
    ['a fractional stock', { stock: 1.5 }],
    ['a stock over 1,000,000', { stock: 1_000_001 }],
    ['a stock sent as text', { stock: '5' }],
    ['a null status', { status: null }],
    ['a null stock', { stock: null }],
    ['a null price', { price: null }],
  ])('rejects %s', async (_label, overrides) => {
    await expect(create({ ...valid, ...overrides })).rejects.toMatchObject({
      status: 400,
    });
  });

  it.each(['id', 'number', 'version', 'archivedAt', 'createdAt', 'updatedAt'])(
    'refuses to set %s from outside (mass assignment)',
    async (field) => {
      await expect(
        create({
          ...valid,
          [field]: field === 'archivedAt' ? '2026-01-01' : 1,
        }),
      ).rejects.toMatchObject({ status: 400 });
    },
  );
});

describe('UpdateProductDto', () => {
  it('needs the version the editor loaded', async () => {
    await expect(update({ name: 'Mug' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(update({ version: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(update({ version: 1.5 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(update({ version: 3 })).resolves.toEqual({ version: 3 });
  });

  it('accepts any subset of the fields', async () => {
    await expect(
      update({ version: 2, price: 9.99, stock: 0, status: 'INACTIVE' }),
    ).resolves.toEqual({
      version: 2,
      price: 9.99,
      stock: 0,
      status: 'INACTIVE',
    });
  });

  it('lets the optional fields be cleared with null or blank text', async () => {
    await expect(
      update({
        version: 1,
        brand: null,
        description: '  ',
        costPrice: null,
      }),
    ).resolves.toMatchObject({
      brand: null,
      description: null,
      costPrice: null,
    });
  });

  it('holds the same limits as creating', async () => {
    for (const bad of [
      { name: 'A' },
      { sku: 'has space' },
      { price: -1 },
      { price: 1.234 },
      { stock: -1 },
      { stock: 2.5 },
      { categoryId: 'nope' },
      { status: 'archived' },
    ]) {
      await expect(update({ version: 1, ...bad })).rejects.toMatchObject({
        status: 400,
      });
    }
  });

  it('does not accept a null for the fields that cannot be cleared', async () => {
    for (const field of [
      'name',
      'sku',
      'categoryId',
      'status',
      'price',
      'stock',
    ]) {
      await expect(update({ version: 1, [field]: null })).rejects.toMatchObject(
        { status: 400 },
      );
    }
  });
});

describe('ArchiveProductsDto', () => {
  it('accepts product ids in any case', async () => {
    await expect(
      archive({ productIds: ['PRD-1001', 'prd-1002'] }),
    ).resolves.toEqual({ productIds: ['PRD-1001', 'prd-1002'] });
  });

  it.each([
    ['no ids', { productIds: [] }],
    ['a missing list', {}],
    ['a list that is not an array', { productIds: 'PRD-1001' }],
    ['a repeated id', { productIds: ['PRD-1001', 'PRD-1001'] }],
    ['a bare number', { productIds: ['1001'] }],
    ['another kind of id', { productIds: ['CUS-1001'] }],
    ['an id that is out of range', { productIds: ['PRD-2147483648'] }],
    [
      'more than 100 ids',
      {
        productIds: Array.from({ length: 101 }, (_, i) => `PRD-${i + 1}`),
      },
    ],
    ['an unknown field', { productIds: ['PRD-1001'], hard: true }],
  ])('rejects %s', async (_label, value) => {
    await expect(archive(value)).rejects.toMatchObject({ status: 400 });
  });
});
