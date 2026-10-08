import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Role } from '../../generated/prisma/client';
import { trim } from './invite-user.dto';

// Query values arrive as strings; map them explicitly instead of trusting coercion.
const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export class ListUsersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isActive?: boolean;
}
