import { IsEnum, IsInt, IsOptional, IsUUID, Min } from 'class-validator';
import { Currency, ProductStatus } from '../../generated/prisma/client';
import {
  Amount,
  BRAND_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  Gallery,
  PrimaryImage,
  ProductName,
  ProductSku,
  StockQuantity,
  SUBTITLE_MAX_LENGTH,
} from './product-fields';
import { Omittable, OptionalText } from '../../common/validators/fields';

/**
 * Every field is optional, but `version` is not: it is the version of the
 * product the editor loaded, so a change is never applied on top of one the
 * editor has not seen (a concurrent edit, or stock moved by an order).
 */
export class UpdateProductDto {
  @IsInt()
  @Min(1)
  version!: number;

  @Omittable()
  @ProductName()
  name?: string;

  @Omittable()
  @ProductSku()
  sku?: string;

  /** Null or blank clears it. */
  @OptionalText(SUBTITLE_MAX_LENGTH)
  subtitle?: string | null;

  /** Null or blank clears it. */
  @OptionalText(BRAND_MAX_LENGTH)
  brand?: string | null;

  /** Null or blank clears it. */
  @OptionalText(DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  /** Null or blank clears it. */
  @PrimaryImage()
  imageUrl?: string | null;

  /** Replaces the whole list; an empty list clears it. */
  @Omittable()
  @Gallery()
  galleryUrls?: string[];

  @Omittable()
  @IsUUID()
  categoryId?: string;

  @Omittable()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @Omittable()
  @Amount()
  price?: number;

  /**
   * Changing it relabels `price` and `costPrice`; nothing is converted, so send
   * the new prices with it.
   */
  @Omittable()
  @IsEnum(Currency)
  currency?: Currency;

  /** Null clears it. */
  @IsOptional()
  @Amount()
  costPrice?: number | null;

  @Omittable()
  @StockQuantity()
  stock?: number;
}
