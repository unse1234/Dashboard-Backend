import { registerDecorator, type ValidationOptions } from 'class-validator';

/**
 * A Pakistani phone number as people write it, in E.164 ("+923001234567"), or
 * null when it is not one.
 *
 * Accepted: spaces, dashes, dots and brackets between digits; the "+92", "0092"
 * and "92" country prefixes (with or without the trunk "0" after them); the
 * national form with a leading "0". Then the national number must be a mobile
 * ("3" and nine more digits) or a landline (an area code and number, nine or ten
 * digits in all). Nothing else is guessed at: extensions and letters are refused.
 */
export function normalizePakistanPhone(raw: string): string | null {
  const compact = raw.trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(compact)) return null;

  let national: string;
  let internationalForm = true;
  if (compact.startsWith('+')) {
    if (!compact.startsWith('+92')) return null;
    national = compact.slice(3);
  } else if (compact.startsWith('0092')) {
    national = compact.slice(4);
  } else if (
    compact.startsWith('92') &&
    (compact.length === 11 || compact.length === 12)
  ) {
    national = compact.slice(2);
  } else if (compact.startsWith('0')) {
    national = compact.slice(1);
    internationalForm = false;
  } else {
    national = compact;
    internationalForm = false;
  }
  // "+92 0300 ..." keeps the trunk zero some people cannot help writing.
  if (internationalForm && national.startsWith('0'))
    national = national.slice(1);

  const mobile = /^3\d{9}$/.test(national);
  const landline = /^[2456789]\d{8,9}$/.test(national);
  return mobile || landline ? `+92${national}` : null;
}

/** The value is a Pakistani phone number (see `normalizePakistanPhone`). */
export function IsPakistanPhone(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object, propertyKey): void => {
    registerDecorator({
      name: 'isPakistanPhone',
      target: object.constructor,
      propertyName: String(propertyKey),
      options: {
        message: `${String(propertyKey)} must be a Pakistani phone number such as 0300 1234567 or +92 300 1234567`,
        ...validationOptions,
      },
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && normalizePakistanPhone(value) !== null,
      },
    });
  };
}
