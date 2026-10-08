import { IsString, MaxLength, MinLength } from 'class-validator';
import { NormalizedEmail } from '../../common/validators/normalized-email.decorator';
import { PASSWORD_MAX_LENGTH } from '../../common/validators/strong-password.decorator';

export class LoginDto {
  @NormalizedEmail()
  email!: string;

  // Deliberately not held to the strength rules: existing passwords must still work.
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;
}
