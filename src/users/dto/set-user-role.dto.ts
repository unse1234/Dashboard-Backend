import { IsEnum } from 'class-validator';
import { Role } from '../../generated/prisma/client';

export class SetUserRoleDto {
  @IsEnum(Role)
  role!: Role;
}
