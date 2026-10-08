import { applyDecorators } from '@nestjs/common';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export const PASSWORD_MIN_LENGTH = 12;
// The upper bound keeps Argon2 from being used to burn CPU with huge inputs.
export const PASSWORD_MAX_LENGTH = 128;

export const StrongPassword = () =>
  applyDecorators(
    IsString(),
    MinLength(PASSWORD_MIN_LENGTH),
    MaxLength(PASSWORD_MAX_LENGTH),
    Matches(/[a-z]/, { message: 'password must contain a lowercase letter' }),
    Matches(/[A-Z]/, { message: 'password must contain an uppercase letter' }),
    Matches(/\d/, { message: 'password must contain a number' }),
  );
