import { Prisma } from '../generated/prisma/client';
import { toProductDto, type ProductRow } from './product.mapper';

const row: ProductRow = {
  id: 'internal-uuid',
  number: 1001,
  name: 'Coffee mug',
  sku: 'MUG-1',
  subtitle: null,
  description: null,
  brand: null,
  imageUrl: 'products/cover.jpg',
  galleryUrls: ['https://cdn.example.com/side.png', 'products/back.webp'],
  categoryId: 'category-uuid',
  category: { name: 'Kitchen' },
  status: 'ACTIVE',
  price: new Prisma.Decimal('20.00'),
  currency: 'USD',
  costPrice: null,
  stock: 5,
  version: 3,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

describe('toProductDto image references', () => {
  it('resolves the cover and ordered gallery without changing stored references', () => {
    const resolveImage = jest.fn((reference: string) =>
      reference.startsWith('products/')
        ? `https://api.example.com/uploads/${reference}`
        : reference,
    );

    const dto = toProductDto(row, resolveImage);

    expect(dto.imageUrl).toBe(
      'https://api.example.com/uploads/products/cover.jpg',
    );
    expect(dto.galleryUrls).toEqual([
      'https://cdn.example.com/side.png',
      'https://api.example.com/uploads/products/back.webp',
    ]);
    expect(resolveImage.mock.calls.map(([reference]) => reference)).toEqual([
      row.imageUrl,
      ...row.galleryUrls,
    ]);
    expect(row.imageUrl).toBe('products/cover.jpg');
    expect(row.galleryUrls).toEqual([
      'https://cdn.example.com/side.png',
      'products/back.webp',
    ]);
  });

  it('preserves existing URLs when no resolver is provided', () => {
    const existing = {
      ...row,
      imageUrl: '/products/cover.png',
      galleryUrls: ['https://cdn.example.com/side.png'],
    };

    expect(toProductDto(existing)).toMatchObject({
      imageUrl: existing.imageUrl,
      galleryUrls: existing.galleryUrls,
    });
  });

  it('keeps the no-image response and does not resolve absent images', () => {
    const resolveImage = jest.fn((reference: string) => reference);

    expect(
      toProductDto({ ...row, imageUrl: null, galleryUrls: [] }, resolveImage),
    ).toMatchObject({ imageUrl: null, galleryUrls: [] });
    expect(resolveImage).not.toHaveBeenCalled();
  });
});
