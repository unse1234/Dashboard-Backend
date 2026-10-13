import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { OptionalText } from '../../../common/validators/fields';
import { IsPakistanPhone } from '../../../common/validators/pakistan-phone';
import { trim } from '../../../users/dto/invite-user.dto';

/**
 * The country the storefront delivers to. Written as people write it ("PK",
 * "pk", "Pakistan"); stored as "PK".
 */
export const DELIVERY_COUNTRY = 'PK';

export function isDeliveryCountry(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return normalized === 'PK' || normalized === 'PAKISTAN';
}

/**
 * Where a guest wants an order delivered. The limits match the dashboard's
 * order address (city, region and country are 100, not the 120 of a name), so
 * whatever is accepted here can be recorded on the order.
 *
 * Whether the country is one the storefront serves is not decided here: that is
 * a business answer (UNSUPPORTED_DESTINATION), not a malformed field.
 */
export class StorefrontAddressDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  recipientName!: string;

  /** The recipient's own number, when it differs from the contact's. */
  @OptionalText(40)
  @IsPakistanPhone()
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

  /** The province or territory. Required: couriers route by it. */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  region!: string;

  /** Optional; when given it is a five-digit Pakistan Post code. */
  @OptionalText(20)
  @Matches(/^\d{5}$/, { message: 'postalCode must be five digits' })
  postalCode?: string | null;

  /** "PK" (or "Pakistan"). */
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  country!: string;
}
