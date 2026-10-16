import { Equals, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ProductStatus } from '../../generated/prisma/client';
import { SHOP_CURRENCY } from '../../common/currency';
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

export class CreateProductDto {
  @ProductName()
  name!: string;

  @ProductSku()
  sku!: string;

  @OptionalText(SUBTITLE_MAX_LENGTH)
  subtitle?: string | null;

  @OptionalText(BRAND_MAX_LENGTH)
  brand?: string | null;

  @OptionalText(DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  /** An http(s) URL or a path on the storefront ("/products/mug.png"). */
  @PrimaryImage()
  imageUrl?: string | null;

  /** Further images in display order. Defaults to none. */
  @Omittable()
  @Gallery()
  galleryUrls?: string[];

  @IsUUID()
  categoryId!: string;

  /** Defaults to ACTIVE. */
  @Omittable()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @Amount()
  price!: number;

  /** Product prices use PKR. Historical orders retain their recorded currency. */
  @Omittable()
  @Equals(SHOP_CURRENCY, { message: 'currency must be PKR' })
  currency?: typeof SHOP_CURRENCY;

  @IsOptional()
  @Amount()
  costPrice?: number | null;

  /** Defaults to 0. */
  @Omittable()
  @StockQuantity()
  stock?: number;
}
