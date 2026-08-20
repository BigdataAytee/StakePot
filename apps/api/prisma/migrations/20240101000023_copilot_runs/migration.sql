-- CreateTable
CREATE TABLE "copilot_runs" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "inputText" TEXT NOT NULL,
    "proposalJson" JSONB NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByDraft" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "copilot_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "copilot_runs_creatorId_createdAt_idx" ON "copilot_runs"("creatorId", "createdAt");

-- AddForeignKey
ALTER TABLE "copilot_runs" ADD CONSTRAINT "copilot_runs_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

