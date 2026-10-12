import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  MoneyAmount,
  Omittable,
  OptionalText,
} from '../../common/validators/fields';
import { IsPublicId } from '../../common/validators/public-id.decorator';
import { trim } from '../../users/dto/invite-user.dto';

export const MAX_LINES = 100;
export const MAX_LINE_QUANTITY = 1000;
export const MAX_ADJUSTMENT = 1_000_000;

const ORDER_PAYMENT_STATUSES = ['PENDING', 'PAID'] as const;

/** A shipping or billing address, as it is recorded on the order. */
export class OrderAddressInputDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  recipientName!: string;

  @OptionalText(40)
  phone?: string | null;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  addressLine1!: string;

  @OptionalText(200)
  addressLine2?: string | null;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  city!: string;

  /** State, province or prefecture, where the country has one. */
  @OptionalText(100)
  region?: string | null;

  @OptionalText(20)
  postalCode?: string | null;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  country!: string;
}

export class OrderLineInputDto {
  /** The product's public id ("PRD-1001"). */
  @IsPublicId('PRD')
  productId!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}

/**
 * What a storefront (or a script) sends to place an order. It carries no
 * prices: each line is priced from the product at the moment its stock is
 * taken, so a client cannot choose what it pays.
 */
export class CreateOrderDto {
  /** The customer's public id ("CUS-1001"). */
  @IsPublicId('CUS')
  customerId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINES)
  @ValidateNested({ each: true })
  @Type(() => OrderLineInputDto)
  items!: OrderLineInputDto[];

  /** Defaults to 0. */
  @Omittable()
  @MoneyAmount(MAX_ADJUSTMENT)
  shipping?: number;

  /** Taken off the order, as a positive amount. Defaults to 0. */
  @Omittable()
  @MoneyAmount(MAX_ADJUSTMENT)
  discount?: number;

  /** Defaults to 0. */
  @Omittable()
  @MoneyAmount(MAX_ADJUSTMENT)
  tax?: number;

  /** Whether the order is already paid. Defaults to PENDING. */
  @Omittable()
  @IsIn(ORDER_PAYMENT_STATUSES)
  paymentStatus?: (typeof ORDER_PAYMENT_STATUSES)[number];

  // ValidateNested alone lets a missing (or null) address through.
  @IsObject()
  @ValidateNested()
  @Type(() => OrderAddressInputDto)
  shippingAddress!: OrderAddressInputDto;

  /** Defaults to the shipping address. */
  @Omittable()
  @IsObject()
  @ValidateNested()
  @Type(() => OrderAddressInputDto)
  billingAddress?: OrderAddressInputDto;
}
