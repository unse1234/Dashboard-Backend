import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { NormalizedEmail } from '../../common/validators/normalized-email.decorator';
import { StrongPassword } from '../../common/validators/strong-password.decorator';

// Tokens are base64url, so anything else can be rejected before touching the database.
const tokenRules = () => (target: object, key: string) => {
  IsString()(target, key);
  MinLength(20)(target, key);
  MaxLength(200)(target, key);
  Matches(/^[A-Za-z0-9_-]+$/, { message: 'token is malformed' })(target, key);
};

export class ForgotPasswordDto {
  @NormalizedEmail()
  email!: string;
}

export class ResetPasswordDto {
  @tokenRules()
  token!: string;

  @StrongPassword()
  password!: string;
}

export class VerifyEmailDto {
  @tokenRules()
  token!: string;
}
