import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsPublicId } from '../../common/validators/public-id.decorator';
import { OrderStatus, PaymentStatus } from '../../generated/prisma/client';
import { trim } from '../../users/dto/invite-user.dto';

export const ORDER_SORT_COLUMNS = [
  'id',
  'customer',
  'createdAt',
  'itemCount',
  'total',
  'paymentStatus',
  'status',
] as const;
export type OrderSortColumn = (typeof ORDER_SORT_COLUMNS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export class ListOrdersQueryDto {
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

  /** Matches the customer's name or email (substring, any case), or an order id. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @IsOptional()
  @IsEnum(PaymentStatus)
  paymentStatus?: PaymentStatus;

  /** One customer's orders, by their public id ("CUS-1001"). */
  @IsOptional()
  @IsPublicId('CUS')
  customerId?: string;

  /** Without it the newest orders come first. */
  @IsOptional()
  @IsIn(ORDER_SORT_COLUMNS)
  sortBy?: OrderSortColumn;

  /** Applies to `sortBy`; ignored without it. */
  @IsOptional()
  @IsIn(SORT_ORDERS)
  sortOrder: SortOrder = 'asc';
}
