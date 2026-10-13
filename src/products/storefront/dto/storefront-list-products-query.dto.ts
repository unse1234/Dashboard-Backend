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
import { trim } from '../../../users/dto/invite-user.dto';

/** Deepest page a visitor can ask for; keeps the OFFSET a sane number. */
export const MAX_PAGE = 10_000;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export const STOREFRONT_SORTS = [
  'newest',
  'price_asc',
  'price_desc',
  'name',
] as const;
export type StorefrontSort = (typeof STOREFRONT_SORTS)[number];

/**
 * What a visitor may ask of the catalogue. There is no status or visibility
 * filter: what is visible is decided on the server, never by the request. Any
 * other query parameter is refused by the global ValidationPipe.
 */
export class StorefrontListProductsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize: number = DEFAULT_PAGE_SIZE;

  /** Matches name, subtitle or brand (substring, any case). */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  /** Newest first by default. Ties are broken by a stable secondary key. */
  @IsOptional()
  @IsIn(STOREFRONT_SORTS)
  sort: StorefrontSort = 'newest';
}
