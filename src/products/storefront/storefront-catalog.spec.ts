import { ValidationPipe } from '@nestjs/common';
import { StorefrontListProductsQueryDto } from './dto/storefront-list-products-query.dto';
import type { StorefrontProductRow } from './storefront-catalog';
import { toStorefrontProduct } from './storefront-product.mapper';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const CATEGORY = '0b6c1f2e-7d6c-4f55-9d35-0d3c8e0b1a11';
const query = (value: unknown) =>
  pipe.transform(value, {
    type: 'query',
    metatype: StorefrontListProductsQueryDto,
  });

describe('StorefrontListProductsQueryDto', () => {
  it('defaults to the newest first, page 1 of 20', async () => {
    await expect(query({})).resolves.toEqual({
      page: 1,
      pageSize: 20,
      sort: 'newest',
    });
  });

  it('converts query strings and trims the search', async () => {
    await expect(
      query({
        page: '3',
        pageSize: '100',
        search: '  mug  ',
        categoryId: CATEGORY,
        sort: 'price_desc',
      }),
    ).resolves.toEqual({
      page: 3,
      pageSize: 100,
      search: 'mug',
      categoryId: CATEGORY,
      sort: 'price_desc',
    });
  });

  it.each(['newest', 'price_asc', 'price_desc', 'name'])(
    'accepts sort=%s',
    async (sort) => {
      await expect(query({ sort })).resolves.toMatchObject({ sort });
    },
  );

  it.each([
    ['page 0', { page: '0' }],
    ['a fractional page', { page: '1.5' }],
    ['a page past the limit', { page: '10001' }],
    ['page size 0', { pageSize: '0' }],
    ['page size over 100', { pageSize: '101' }],
    ['a search over 100 characters', { search: 'a'.repeat(101) }],
    ['a category that is not a uuid', { categoryId: 'Electronics' }],
    ['an unknown sort', { sort: 'costPrice' }],
    ['a sort in another case', { sort: 'Newest' }],
    ['a status filter', { status: 'INACTIVE' }],
    ['an archived filter', { archived: 'true' }],
    ['an unknown parameter', { sortBy: 'price' }],
  ])('rejects %s', async (_label, value) => {
    await expect(query(value)).rejects.toMatchObject({ status: 400 });
  });
});

const row: StorefrontProductRow = {
  number: 1001,
  name: 'Wireless Headphones',
  subtitle: 'Noise cancelling',
  description: 'Over-ear.',
  brand: 'Aural',
  imageUrl: '/products/headphones.png',
  galleryUrls: ['/products/h2.png', '/products/h3.png'],
  price: '24999.00',
  currency: 'PKR',
  inStock: true,
  categoryId: CATEGORY,
  categoryName: 'Electronics',
};

describe('toStorefrontProduct', () => {
  it('projects exactly the public fields', () => {
    expect(toStorefrontProduct(row)).toEqual({
      id: 'PRD-1001',
      name: 'Wireless Headphones',
      subtitle: 'Noise cancelling',
      description: 'Over-ear.',
      brand: 'Aural',
      category: { id: CATEGORY, name: 'Electronics' },
      price: 24999,
      currency: 'PKR',
      image: {
        url: '/products/headphones.png',
        alt: 'Wireless Headphones',
      },
      gallery: [
        { url: '/products/h2.png', alt: 'Wireless Headphones, view 2' },
        { url: '/products/h3.png', alt: 'Wireless Headphones, view 3' },
      ],
      inStock: true,
    });
  });

  it('has no image, and no gallery, when the product has none', () => {
    expect(
      toStorefrontProduct({ ...row, imageUrl: null, galleryUrls: [] }),
    ).toMatchObject({ image: null, gallery: [] });
  });

  it('does not carry columns the projection does not name', () => {
    const projected = toStorefrontProduct({
      ...row,
      sku: 'SECRET-SKU',
      costPrice: '1.00',
      stock: 5,
      id: 'internal-uuid',
    } as StorefrontProductRow);
    expect(JSON.stringify(projected)).not.toMatch(/SECRET-SKU|internal-uuid/);
    expect(Object.keys(projected).sort()).toEqual([
      'brand',
      'category',
      'currency',
      'description',
      'gallery',
      'id',
      'image',
      'inStock',
      'name',
      'price',
      'subtitle',
    ]);
  });
});
