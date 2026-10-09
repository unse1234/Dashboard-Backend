/**
 * Escapes the LIKE metacharacters %, _ and \ so user input matches literally.
 * Prisma passes `contains` straight into LIKE, and raw queries need it too.
 */
export const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');
