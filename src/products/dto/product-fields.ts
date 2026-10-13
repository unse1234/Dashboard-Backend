import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { emptyToNull, MoneyAmount } from '../../common/validators/fields';
import {
  IMAGE_REFERENCE_MAX_LENGTH,
  IsImageReference,
} from '../../common/validators/image-reference.decorator';
import { trim } from '../../users/dto/invite-user.dto';

// The same limits as the dashboard's product form (src/lib/products/product.schemas.ts).
export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 120;
export const SKU_MAX_LENGTH = 64;
export const BRAND_MAX_LENGTH = 80;
export const CATEGORY_NAME_MAX_LENGTH = 80;
export const DESCRIPTION_MAX_LENGTH = 2000;
export const SUBTITLE_MAX_LENGTH = 160;
/** Images beyond the primary one. */
export const GALLERY_MAX_SIZE = 10;
export const PRICE_MAX = 1_000_000;
export const STOCK_MAX = 1_000_000;

export const ProductName = () =>
  applyDecorators(
    Transform(trim),
    IsString(),
    MinLength(NAME_MIN_LENGTH),
    MaxLength(NAME_MAX_LENGTH),
  );

export const ProductSku = () =>
  applyDecorators(
    Transform(trim),
    IsString(),
    MinLength(1),
    MaxLength(SKU_MAX_LENGTH),
    Matches(/^\S+$/, { message: 'sku must not contain spaces' }),
  );

/** A selling or cost price. */
export const Amount = () => MoneyAmount(PRICE_MAX);

export const StockQuantity = () =>
  applyDecorators(IsInt(), Min(0), Max(STOCK_MAX));

/** The primary image. Null or blank clears it. */
export const PrimaryImage = () =>
  applyDecorators(
    IsOptional(),
    Transform(emptyToNull),
    MaxLength(IMAGE_REFERENCE_MAX_LENGTH),
    IsImageReference(),
  );

/** Further images in display order, each once. An empty list clears them. */
export const Gallery = () =>
  applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      Array.isArray(value)
        ? value.map((item: unknown) =>
            typeof item === 'string' ? item.trim() : item,
          )
        : value,
    ),
    IsArray(),
    ArrayMaxSize(GALLERY_MAX_SIZE),
    ArrayUnique(),
    IsImageReference({ each: true }),
  );
