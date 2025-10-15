-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "referrer" TEXT;

-- CreateTable
CREATE TABLE "ReferralEdge" (
    "player" TEXT NOT NULL,
    "referrer" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralEdge_pkey" PRIMARY KEY ("player")
);

-- CreateTable
CREATE TABLE "ReferralContribution" (
    "id" TEXT NOT NULL,
    "player" TEXT NOT NULL,
    "referrer" TEXT,
    "level" INTEGER NOT NULL,
    "amount" DECIMAL(78,0) NOT NULL,
    "requestId" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralContribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferralContribution_player_idx" ON "ReferralContribution"("player");

-- CreateIndex
CREATE INDEX "ReferralContribution_referrer_idx" ON "ReferralContribution"("referrer");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralContribution_requestId_level_key" ON "ReferralContribution"("requestId", "level");
