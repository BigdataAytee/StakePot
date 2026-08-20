-- CreateEnum
CREATE TYPE "SourceCadence" AS ENUM ('auto', 'urgent', 'normal', 'background');

-- AlterTable
ALTER TABLE "source_items" ADD COLUMN     "guid" TEXT;

-- AlterTable
ALTER TABLE "sources" ADD COLUMN     "cadence" "SourceCadence" NOT NULL DEFAULT 'auto',
ADD COLUMN     "etag" TEXT,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastItemAt" TIMESTAMP(3),
ADD COLUMN     "lastModified" TEXT,
ADD COLUMN     "publishWindow" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "source_items_sourceId_guid_key" ON "source_items"("sourceId", "guid");

