import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { NormalizedEmail } from '../../common/validators/normalized-email.decorator';
import {
  PASSWORD_MAX_LENGTH,
  StrongPassword,
} from '../../common/validators/strong-password.decorator';

// Tokens are a 3-character prefix and 43 characters; anything far longer is
// not one, and is refused before it is hashed. The prefix and characters are
// checked where the token is looked up, with one answer for every bad token.
const MAX_TOKEN_LENGTH = 200;

const tokenRules = () => (target: object, key: string) => {
  IsString()(target, key);
  MinLength(1)(target, key);
  MaxLength(MAX_TOKEN_LENGTH)(target, key);
};

/** The setup permission ("as_…"), from the confirmation answer or an emailed link. */
export class SetupTokenDto {
  @tokenRules()
  setupToken!: string;
}

/**
 * Creating an account. There is no email field: the address is the one the
 * setup token was issued for, and an `email` sent anyway is refused by the
 * validation pipe (forbidNonWhitelisted).
 */
export class AccountSetupDto extends SetupTokenDto {
  @StrongPassword()
  password!: string;

  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  confirmPassword!: string;
}

/**
 * Asking for a new setup link by email: either for an address typed in, or
 * for the address of a setup token that has run out. Exactly one of the two.
 */
export class RequestSetupLinkDto {
  @IsOptional()
  @NormalizedEmail()
  email?: string;

  @IsOptional()
  @tokenRules()
  setupToken?: string;
}

export class StorefrontSignInDto {
  @NormalizedEmail()
  email!: string;

  // Not held to the strength rules here: only checked against the stored hash.
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}

export class StorefrontForgotPasswordDto {
  @NormalizedEmail()
  email!: string;
}

export class StorefrontResetPasswordDto {
  @tokenRules()
  token!: string;

  @StrongPassword()
  password!: string;

  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  confirmPassword!: string;
}

/** The most orders one history page holds. */
export const MAX_ACCOUNT_ORDERS_PAGE_SIZE = 50;

/**
 * A page of the signed-in shopper's orders. Only paging: the account is the
 * session's, and anything else in the query (an account or customer id
 * included) is refused by the validation pipe (forbidNonWhitelisted).
 */
export class AccountOrdersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ACCOUNT_ORDERS_PAGE_SIZE)
  pageSize: number = 10;
}
