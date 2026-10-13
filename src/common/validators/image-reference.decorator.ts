import { registerDecorator, type ValidationOptions } from 'class-validator';

export const IMAGE_REFERENCE_MAX_LENGTH = 500;

/** Whitespace, control characters and backslashes have no place in a reference. */
const hasUnsafeCharacter = (value: string) =>
  /\s/.test(value) ||
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f || character === '\\';
  });

/**
 * Where an image can be loaded from: an absolute http(s) URL, or a path on the
 * storefront's own origin ("/products/mug.png"). Nothing else is an image:
 * `javascript:` and `data:` URLs and protocol-relative ("//host") paths are refused,
 * because a stored reference ends up in an `<img src>` on a public page.
 */
export function isImageReference(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > IMAGE_REFERENCE_MAX_LENGTH) {
    return false;
  }
  if (hasUnsafeCharacter(value)) return false;

  if (value.startsWith('/')) {
    return !value.startsWith('//') && !value.split('/').includes('..');
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

/**
 * The value is an image reference (see `isImageReference`). Pass `{ each: true }`
 * to check every element of an array.
 */
export function IsImageReference(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object, propertyKey): void => {
    const propertyName = String(propertyKey);
    registerDecorator({
      name: 'isImageReference',
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be an http(s) URL or a path starting with "/"`,
        ...validationOptions,
      },
      validator: { validate: (value: unknown) => isImageReference(value) },
    });
  };
}
