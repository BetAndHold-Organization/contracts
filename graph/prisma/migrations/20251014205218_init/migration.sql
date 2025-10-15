-- CreateEnum
CREATE TYPE "BetStatus" AS ENUM ('PENDING', 'RESOLVED', 'FAILED');

-- CreateEnum
CREATE TYPE "OutcomeType" AS ENUM ('LOSE', 'MULTIPLIER', 'JACKPOT');

-- CreateEnum
CREATE TYPE "JackpotEventType" AS ENUM ('TIER', 'JACKPOT', 'CONSOLATION');

-- CreateTable
CREATE TABLE "Bet" (
    "id" TEXT NOT NULL,
    "requestId" BIGINT NOT NULL,
    "player" TEXT NOT NULL,
    "referrer" TEXT,
    "blockNumber" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "wager" DECIMAL(78,0) NOT NULL,
    "netStake" DECIMAL(78,0) NOT NULL,
    "jackpotContribution" DECIMAL(78,0) NOT NULL,
    "multiplierHundredths" INTEGER NOT NULL,
    "status" "BetStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Bet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BetOutcome" (
    "betId" TEXT NOT NULL,
    "outcome" "OutcomeType" NOT NULL,
    "payout" DECIMAL(78,0) NOT NULL,
    "jackpotPayout" DECIMAL(78,0) NOT NULL,
    "spinsConsumed" INTEGER NOT NULL,
    "fulfillTx" TEXT,
    "failureReason" TEXT,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BetOutcome_pkey" PRIMARY KEY ("betId")
);

-- CreateTable
CREATE TABLE "Player" (
    "address" TEXT NOT NULL,
    "totalBets" INTEGER NOT NULL DEFAULT 0,
    "totalWager" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "totalPayout" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "totalJackpot" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "netResult" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "lastActive" TIMESTAMP(3),
    "totalContribution" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "lastContribution" TIMESTAMP(3),

    CONSTRAINT "Player_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "ReferralReward" (
    "address" TEXT NOT NULL,
    "pending" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "claimed" DECIMAL(78,0) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralReward_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "JackpotEvent" (
    "id" BIGSERIAL NOT NULL,
    "betId" TEXT,
    "player" TEXT,
    "type" "JackpotEventType" NOT NULL,
    "tierIndex" INTEGER,
    "payout" DECIMAL(78,0) NOT NULL,
    "consolationMultiplier" DECIMAL(10,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JackpotEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiquiditySnapshot" (
    "id" BIGSERIAL NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rouletteBalance" DECIMAL(78,0) NOT NULL,
    "jackpotBalance" DECIMAL(78,0) NOT NULL,
    "handlerBalance" DECIMAL(78,0) NOT NULL,
    "referralBalance" DECIMAL(78,0) NOT NULL,
    "houseBalance" DECIMAL(78,0) NOT NULL,

    CONSTRAINT "LiquiditySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexerState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "lastProcessedBlock" BIGINT NOT NULL,
    "lastProcessedHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndexerState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Bet_requestId_key" ON "Bet"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "Bet_txHash_key" ON "Bet"("txHash");

-- AddForeignKey
ALTER TABLE "BetOutcome" ADD CONSTRAINT "BetOutcome_betId_fkey" FOREIGN KEY ("betId") REFERENCES "Bet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JackpotEvent" ADD CONSTRAINT "JackpotEvent_betId_fkey" FOREIGN KEY ("betId") REFERENCES "Bet"("id") ON DELETE SET NULL ON UPDATE CASCADE;
