-- AlterEnum
-- The guest checkout's receipt token (see StorefrontTokenPurpose). Adding an
-- enum value changes no existing row.
ALTER TYPE "StorefrontTokenPurpose" ADD VALUE 'CHECKOUT_RECEIPT';
