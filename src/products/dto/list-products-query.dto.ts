import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { trim } from '../../users/dto/invite-user.dto';

/**
 * What the status filter means, as the product screens derive it: ACTIVE is on
 * sale with stock, OUT_OF_STOCK is on sale without stock, and INACTIVE is
 * switched off whatever its stock.
 */
export const PRODUCT_STATUS_FILTERS = [
  'ACTIVE',
  'INACTIVE',
  'OUT_OF_STOCK',
] as const;
export type ProductStatusFilter = (typeof PRODUCT_STATUS_FILTERS)[number];

export class ListProductsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  /** Matches name or SKU (substring, any case), or a product id. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsIn(PRODUCT_STATUS_FILTERS)
  status?: ProductStatusFilter;
}
