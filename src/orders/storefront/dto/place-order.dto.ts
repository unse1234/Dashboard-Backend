import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsObject,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { NormalizedEmail } from '../../../common/validators/normalized-email.decorator';
import { IsPakistanPhone } from '../../../common/validators/pakistan-phone';
import { trim } from '../../../users/dto/invite-user.dto';
import { MAX_LINES } from '../../dto/create-order.dto';
import { BagLineDto } from './bag-quote.dto';
import { StorefrontAddressDto } from './storefront-address.dto';

/** Who is buying, as the order will record them. */
export class GuestContactDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @NormalizedEmail()
  email!: string;

  /** A Pakistani number the courier can call. Kept as it was typed. */
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  @IsPakistanPhone()
  phone!: string;
}

// The longest token a quote can be (see QuoteTokenService).
const MAX_QUOTE_TOKEN_LENGTH = 16_384;

/**
 * What a guest sends to place a cash-on-delivery order. There is deliberately no
 * field for a customer, an amount, a status, a currency or a card: the global
 * validation refuses unknown fields, so none of those can be smuggled in. The
 * server prices the order and holds it against the quote the guest reviewed.
 */
export class PlaceOrderDto {
  @IsObject()
  @ValidateNested()
  @Type(() => GuestContactDto)
  contact!: GuestContactDto;

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

  /** The `quoteToken` of the checkout quote the guest reviewed, unchanged. */
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_QUOTE_TOKEN_LENGTH)
  quoteToken!: string;
}
