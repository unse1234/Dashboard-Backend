import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Omittable } from '../../../common/validators/fields';
import { IsPublicId } from '../../../common/validators/public-id.decorator';
import { MAX_LINE_QUANTITY, MAX_LINES } from '../../dto/create-order.dto';
import { BAG_ACTION_TYPES, type BagActionType } from '../bag-engine';
import { StorefrontAddressDto } from './storefront-address.dto';

/** A line of a bag. Carries no price: the server prices every line. */
export class BagLineDto {
  /** The product's public id ("PRD-1001"), in any case. */
  @IsPublicId('PRD')
  productId!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}

export class BagActionDto {
  @IsIn(BAG_ACTION_TYPES)
  type!: BagActionType;

  @IsPublicId('PRD')
  productId!: string;

  /** For `add` (default 1) and `set` (required). Refused for the others. */
  @Omittable()
  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity?: number;
}

/**
 * The bag as the client last received it, and optionally one change to make to
 * it. An empty bag is valid. The client never does the arithmetic: it sends
 * what the user did and renders what comes back.
 */
export class BagQuoteDto {
  @IsArray()
  @ArrayMaxSize(MAX_LINES + 1)
  @ValidateNested({ each: true })
  @Type(() => BagLineDto)
  items!: BagLineDto[];

  @Omittable()
  @IsObject()
  @ValidateNested()
  @Type(() => BagActionDto)
  action?: BagActionDto;
}

/** The bag to be bought, and where it is going. Needs at least one line. */
export class CheckoutQuoteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINES)
  @ValidateNested({ each: true })
  @Type(() => BagLineDto)
  items!: BagLineDto[];

  // ValidateNested alone lets a missing (or null) address through.
  @IsObject()
  @ValidateNested()
  @Type(() => StorefrontAddressDto)
  shippingAddress!: StorefrontAddressDto;
}
