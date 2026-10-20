import { IsString, MaxLength, MinLength } from 'class-validator';

// Tokens are a 3-character prefix and 43 characters; anything far longer is
// not one, and is refused before it is hashed.
const MAX_TOKEN_LENGTH = 200;

/** The token from a confirmation link ("oc_…"), sent in the body, never a URL. */
export class ConfirmationTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_TOKEN_LENGTH)
  token!: string;
}

/** The guest's checkout receipt ("cr_…") from the placement answer. */
export class CheckoutReceiptDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_TOKEN_LENGTH)
  receiptToken!: string;
}
