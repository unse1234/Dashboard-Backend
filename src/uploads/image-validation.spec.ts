import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { JPEG, PNG, WEBP, imageFile } from '../../test/fixtures/product-images';
import {
  MAX_IMAGE_BYTES,
  isLocalImageKey,
  validateBatch,
  validateImage,
} from './image-validation';

describe('product image validation', () => {
  it.each([
    ['jpg', JPEG],
    ['png', PNG],
    ['webp', WEBP],
  ] as const)(
    'identifies %s from contents despite misleading filename and MIME',
    (extension, buffer) => {
      expect(validateImage(imageFile(buffer))).toBe(extension);
    },
  );

  it.each([
    Buffer.alloc(0),
    Buffer.from('<svg><script>alert(1)</script></svg>'),
    Buffer.from('GIF89a'),
    Buffer.from('%PDF-1.7'),
    PNG.subarray(0, 8),
    JPEG.subarray(0, -2),
    WEBP.subarray(0, -2),
  ])('rejects unsupported or incomplete contents', (buffer) => {
    expect(() => validateImage(imageFile(buffer))).toThrow(BadRequestException);
  });

  it('rejects a damaged PNG chunk even with a correct signature', () => {
    const damaged = Buffer.from(PNG);
    damaged[45] ^= 1;
    expect(() => validateImage(imageFile(damaged))).toThrow(
      BadRequestException,
    );
  });

  it('bounds actual byte size even when the size metadata lies', () => {
    expect(() =>
      validateImage({ ...imageFile(), size: MAX_IMAGE_BYTES + 1 }),
    ).toThrow(PayloadTooLargeException);
    expect(() =>
      validateImage({
        ...imageFile(Buffer.alloc(MAX_IMAGE_BYTES + 1)),
        size: 1,
      }),
    ).toThrow(PayloadTooLargeException);
  });

  it('validates every file before accepting a bounded batch', () => {
    expect(() => validateBatch([])).toThrow(BadRequestException);
    expect(() =>
      validateBatch(Array.from({ length: 9 }, () => imageFile())),
    ).toThrow(BadRequestException);
    expect(() =>
      validateBatch([imageFile(), imageFile(Buffer.from('bad'))]),
    ).toThrow(BadRequestException);
    expect(() =>
      validateBatch(Array.from({ length: 8 }, () => imageFile())),
    ).not.toThrow();
  });

  it('recognizes only server-generated relative UUID file keys', () => {
    expect(
      isLocalImageKey('products/12222535-c312-4aa1-8a11-65222c111111.png'),
    ).toBe(true);
    for (const key of [
      '../file.png',
      '/products/12222535-c312-4aa1-8a11-65222c111111.png',
      'products/../../file.png',
      'products/%2e%2e/file.png',
      'products/file.svg',
      'https://cdn.example.com/a.png',
      'C:\\uploads\\file.png',
    ])
      expect(isLocalImageKey(key)).toBe(false);
  });
});
