-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('USD', 'PKR');

-- AlterTable
-- Every existing product keeps the currency the system has always used (USD);
-- nothing is converted or relabelled. The subtitle and the images are optional.
ALTER TABLE "Product" ADD COLUMN     "currency" "Currency" NOT NULL DEFAULT 'USD',
ADD COLUMN     "galleryUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "subtitle" TEXT;
