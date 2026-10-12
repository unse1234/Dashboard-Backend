import { registerDecorator, type ValidationOptions } from 'class-validator';
import { parsePublicId, type PublicIdPrefix } from '../public-id';

/**
 * The value is a public id of the given kind, such as "PRD-1001". Pass
 * `{ each: true }` to check every element of an array.
 */
export function IsPublicId(
  prefix: PublicIdPrefix,
  validationOptions?: ValidationOptions,
) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'isPublicId',
      target: object.constructor,
      propertyName,
      constraints: [prefix],
      options: {
        message: `${propertyName} must contain ids like "${prefix}-1001"`,
        ...validationOptions,
      },
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && parsePublicId(prefix, value) !== null,
      },
    });
  };
}
