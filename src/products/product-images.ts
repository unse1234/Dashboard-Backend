import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Db } from '../prisma/prisma.service';
import {
  IMAGE_WRITE_LOCK,
  MAX_PRODUCT_IMAGES,
  isLocalImageKey,
} from '../uploads/image-validation';
import type { UploadsService } from '../uploads/uploads.service';

export interface ImageReferences {
  imageUrl: string | null;
  galleryUrls: string[];
}

export interface ProductImageDto {
  /** UUID for an uploaded file; ext-<sha256> for an existing URL reference. */
  id: string;
  url: string;
  isCover: boolean;
  /** Zero-based display order. */
  position: number;
}

export const IMAGE_LIMIT_MESSAGE = 'A product can have at most 8 images';

export function imageReferences(product: ImageReferences): string[] {
  return [
    ...(product.imageUrl ? [product.imageUrl] : []),
    ...product.galleryUrls,
  ];
}

export function imageId(reference: string): string {
  return isLocalImageKey(reference)
    ? reference.slice('products/'.length).split('.')[0]
    : `ext-${createHash('sha256').update(reference).digest('hex')}`;
}

export function toImageDtos(
  product: ImageReferences,
  uploads: Pick<UploadsService, 'publicUrl'>,
): ProductImageDto[] {
  return imageReferences(product).map((reference, position) => ({
    id: imageId(reference),
    url: uploads.publicUrl(reference),
    isCover: Boolean(product.imageUrl) && position === 0,
    position,
  }));
}

/** Shared with cleanup so a reference cannot be linked while being removed. */
export async function lockProductImages(db: Db): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(${IMAGE_WRITE_LOCK})`;
}

/** Managed images may only be retained or reordered by their owning product. */
export function normalizeImageChanges(
  dto: { imageUrl?: string | null; galleryUrls?: string[] },
  current: ImageReferences | null,
  uploads: Pick<UploadsService, 'storageKey'>,
): void {
  const owned = new Set(
    current
      ? imageReferences(current).map((ref) => uploads.storageKey(ref) ?? ref)
      : [],
  );
  const normalize = (reference: string) => {
    const key = uploads.storageKey(reference);
    if (!key) return reference;
    if (!owned.has(key))
      throw new BadRequestException(
        'Uploaded images must already belong to this product',
      );
    return key;
  };
  if (dto.imageUrl) dto.imageUrl = normalize(dto.imageUrl);
  if (dto.galleryUrls) dto.galleryUrls = dto.galleryUrls.map(normalize);
  const next = {
    imageUrl:
      dto.imageUrl === undefined ? (current?.imageUrl ?? null) : dto.imageUrl,
    galleryUrls: dto.galleryUrls ?? current?.galleryUrls ?? [],
  };
  const count = imageReferences(next).length;
  // Legacy products above today's limit remain editable without losing images.
  if (
    count > MAX_PRODUCT_IMAGES &&
    count > (current ? imageReferences(current).length : 0)
  ) {
    throw new BadRequestException(IMAGE_LIMIT_MESSAGE);
  }
}
