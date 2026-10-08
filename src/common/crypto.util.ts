import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** URL-safe random token with 256 bits of entropy by default. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Hash for storing high-entropy random tokens. A fast hash is appropriate here
 * because the input is not guessable; passwords use Argon2 instead.
 */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
