import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ProductStatus } from '../../generated/prisma/client';
import {
  Amount,
  BRAND_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  ProductName,
  ProductSku,
  StockQuantity,
} from './product-fields';
import { Omittable, OptionalText } from '../../common/validators/fields';

export class CreateProductDto {
  @ProductName()
  name!: string;

  @ProductSku()
  sku!: string;

  @OptionalText(BRAND_MAX_LENGTH)
  brand?: string | null;

  @OptionalText(DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @IsUUID()
  categoryId!: string;

  /** Defaults to ACTIVE. */
  @Omittable()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @Amount()
  price!: number;

  @IsOptional()
  @Amount()
  costPrice?: number | null;

  /** Defaults to 0. */
  @Omittable()
  @StockQuantity()
  stock?: number;
}
