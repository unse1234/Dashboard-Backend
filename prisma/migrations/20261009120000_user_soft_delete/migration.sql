-- AlterTable
-- Nullable with no default: existing rows are untouched and no data is rewritten.
ALTER TABLE "User" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- A soft-deleted account must never be active. Every sign-in, refresh and token check
-- keys off "isActive", so this makes "deleted users cannot authenticate" a database
-- guarantee. Prisma does not model CHECK constraints; it neither manages nor drops it.
ALTER TABLE "User" ADD CONSTRAINT "User_deleted_not_active_check" CHECK ("deletedAt" IS NULL OR "isActive" = false);
