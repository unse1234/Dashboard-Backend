import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { trim } from '../../users/dto/invite-user.dto';

export const CUSTOMER_SORT_COLUMNS = [
  'id',
  'name',
  'email',
  'totalOrders',
  'totalSpent',
  'joinedAt',
] as const;
export type CustomerSortColumn = (typeof CUSTOMER_SORT_COLUMNS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export class ListCustomersQueryDto {
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

  /** Matches name, email or phone (substring, any case), or a customer id. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  /** Without it the newest customers come first. */
  @IsOptional()
  @IsIn(CUSTOMER_SORT_COLUMNS)
  sortBy?: CustomerSortColumn;

  /** Applies to `sortBy`; ignored without it. */
  @IsOptional()
  @IsIn(SORT_ORDERS)
  sortOrder: SortOrder = 'asc';
}
