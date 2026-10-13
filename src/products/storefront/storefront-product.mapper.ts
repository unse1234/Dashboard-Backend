import { toAmount } from '../../common/money';
import { formatPublicId } from '../../common/public-id';
import type { Currency } from '../../generated/prisma/client';
import type { StorefrontProductRow } from './storefront-catalog';

export interface StorefrontImageDto {
  url: string;
  /** What the picture is of, for screen readers. Generated from the product. */
  alt: string;
}

/** A product as a visitor to the storefront sees it. */
export interface StorefrontProductDto {
  /** Public id, "PRD-<number>". */
  id: string;
  name: string;
  subtitle: string | null;
  description: string | null;
  brand: string | null;
  category: { id: string; name: string };
  /** Selling price, in `currency`. */
  price: number;
  currency: Currency;
  /** The primary image; null when the product has none. */
  image: StorefrontImageDto | null;
  /** Further images in display order. */
  gallery: StorefrontImageDto[];
  /** False for a sold-out product, which is still listed. */
  inStock: boolean;
}

// Each field is listed explicitly, so a column added to Product later never
// reaches a public response by accident.
export function toStorefrontProduct(
  row: StorefrontProductRow,
): StorefrontProductDto {
  return {
    id: formatPublicId('PRD', row.number),
    name: row.name,
    subtitle: row.subtitle,
    description: row.description,
    brand: row.brand,
    category: { id: row.categoryId, name: row.categoryName },
    price: toAmount(row.price),
    currency: row.currency,
    image: row.imageUrl ? { url: row.imageUrl, alt: row.name } : null,
    // The primary image is view 1; the gallery continues from 2.
    gallery: row.galleryUrls.map((url, index) => ({
      url,
      alt: `${row.name}, view ${index + 2}`,
    })),
    inStock: row.inStock,
  };
}
