import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * The field may be left out, but once it is present it must be valid. Unlike
 * `IsOptional`, a null is not "absent" here: it fails, so a field that cannot be
 * cleared can never reach a service as null.
 */
export const Omittable = () =>
  ValidateIf((_object, value: unknown) => value !== undefined);

/** Whitespace-only text counts as empty, and empty means "none". */
export const emptyToNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** Optional text that may be sent as null (or blank) to clear it. */
export const OptionalText = (maxLength: number) =>
  applyDecorators(
    IsOptional(),
    Transform(emptyToNull),
    IsString(),
    MaxLength(maxLength),
  );

/** Dollars and cents: not negative, at most two decimals, up to `max`. */
export const MoneyAmount = (max: number) =>
  applyDecorators(
    IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 }),
    Min(0),
    Max(max),
  );
