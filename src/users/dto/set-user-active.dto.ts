import { IsBoolean } from 'class-validator';

export class SetUserActiveDto {
  // Strict boolean: no string coercion, so "false" is rejected rather than read as truthy.
  @IsBoolean()
  isActive!: boolean;
}
