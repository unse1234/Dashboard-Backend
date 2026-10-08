import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Role } from '../../generated/prisma/client';
import { NormalizedEmail } from '../../common/validators/normalized-email.decorator';

export const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Deliberately has no password field: the invited person chooses their own via
 * the emailed link, so an administrator never learns it.
 */
export class InviteUserDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @NormalizedEmail()
  email!: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}
