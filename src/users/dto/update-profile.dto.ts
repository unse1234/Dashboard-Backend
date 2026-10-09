import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { trim } from './invite-user.dto';

/**
 * What a user may change about themselves. Deliberately only the display name:
 * the global ValidationPipe rejects every other property (role, isActive, email,
 * verification state, ...), so there is nothing to mass-assign.
 */
export class UpdateProfileDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}
