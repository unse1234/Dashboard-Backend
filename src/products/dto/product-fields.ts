import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MoneyAmount } from '../../common/validators/fields';
import { trim } from '../../users/dto/invite-user.dto';

// The same limits as the dashboard's product form (src/lib/products/product.schemas.ts).
export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 120;
export const SKU_MAX_LENGTH = 64;
export const BRAND_MAX_LENGTH = 80;
export const DESCRIPTION_MAX_LENGTH = 2000;
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
