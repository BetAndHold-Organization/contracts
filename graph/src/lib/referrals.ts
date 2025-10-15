import { PrismaClient, Prisma } from "@prisma/client";
import type { PublicClient, Hex } from "viem";

import type { ContractsConfig } from "./contracts.js";

const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";
const BPS_DENOMINATOR = 10_000n;

type SpinContext = {
  requestId: bigint;
  player: `0x${string}`;
  wager: bigint;
  netStake: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
};

type ContributionEntry = {
  referrer: string;
  level: number;
  amount: bigint;
};

type ChainEntry = {
  address: string;
  level: number;
  bps: bigint;
};

export class ReferralService {
  private houseEdgeBps = 0n;
  private referralBps = 0n;
  private levelBps: bigint[] = [];
  private fallbackReceiver: string | null = null;

  private constructor(
    private readonly db: PrismaClient,
    private readonly client: PublicClient,
    private readonly contracts: ContractsConfig
  ) {}

  static async create(
    db: PrismaClient,
    client: PublicClient,
    contracts: ContractsConfig
  ) {
    const service = new ReferralService(db, client, contracts);
    await service.refreshAll();
    return service;
  }

  async refreshAll() {
    await Promise.all([
      this.refreshHandlerConfig(),
      this.refreshLevels(),
      this.refreshFallbackReceiver(),
    ]);
  }

  async refreshHandlerConfig() {
    try {
      const [, , , houseEdgeBps, referralBps] = (await this.client.readContract({
        address: this.contracts.handlerAddress,
        abi: this.contracts.handlerAbi,
        functionName: "getGameConfig",
        args: [this.contracts.rouletteAddress],
      })) as [boolean, `0x${string}`, `0x${string}`, bigint, bigint];

      this.houseEdgeBps = BigInt(houseEdgeBps);
      this.referralBps = BigInt(referralBps);
    } catch (error) {
      console.error("Failed to refresh handler config", error);
    }
  }

  async refreshLevels() {
    try {
      const [rawCount, rawLevels] = (await this.client.readContract({
        address: this.contracts.referralAddress,
        abi: this.contracts.referralAbi,
        functionName: "getLevels",
        args: [],
      })) as unknown as [bigint, bigint[]];

      const levelCount = Number(rawCount);
      this.levelBps = Array.from({ length: levelCount }, (_, idx) =>
        BigInt(rawLevels[idx] ?? 0n)
      );
    } catch (error) {
      console.error("Failed to refresh referral levels", error);
      this.levelBps = [];
    }
  }

  async refreshFallbackReceiver() {
    try {
      const defaultReceiver = (await this.client.readContract({
        address: this.contracts.referralAddress,
        abi: this.contracts.referralAbi,
        functionName: "defaultReceiver",
        args: [],
      })) as unknown as `0x${string}`;

      if (defaultReceiver !== ZERO_ADDRESS) {
        this.fallbackReceiver = defaultReceiver.toLowerCase();
        return;
      }

      const owner = (await this.client.readContract({
        address: this.contracts.referralAddress,
        abi: this.contracts.referralAbi,
        functionName: "owner",
        args: [],
      })) as unknown as `0x${string}`;

      this.fallbackReceiver = owner.toLowerCase();
    } catch (error) {
      console.error("Failed to refresh fallback receiver", error);
      this.fallbackReceiver = null;
    }
  }

  async handleLevelsUpdated() {
    await this.refreshLevels();
  }

  async handleDefaultReceiverSet() {
    await this.refreshFallbackReceiver();
  }

  async handlePaymentHandlerSet() {
    await this.refreshHandlerConfig();
  }

  async processSpin(payload: SpinContext): Promise<string | null> {
    const referralAmount = this.computeReferralAmount(
      payload.wager,
      payload.netStake
    );
    const player = payload.player.toLowerCase();

    if (referralAmount <= 0n) {
      await this.recordPlayerReferrer(player, null);
      return null;
    }

    const chain = await this.buildChain(player);

    if (chain.length === 0) {
      await this.recordPlayerReferrer(player, null);
      if (this.fallbackReceiver) {
        await this.persistContributions(payload, [
          {
            referrer: this.fallbackReceiver,
            level: -1,
            amount: referralAmount,
          },
        ]);
      }
      return null;
    }

    const contributions = this.allocateShares(referralAmount, chain);
    if (contributions.length === 0) {
      await this.recordPlayerReferrer(player, null);
      return null;
    }

    await this.persistContributions(payload, contributions);
    const directReferrer = contributions[0]?.referrer ?? null;
    await this.recordPlayerReferrer(player, directReferrer);
    return directReferrer;
  }

  async handleReferrerRecorded(player: `0x${string}`, referrer: `0x${string}`) {
    const playerLower = player.toLowerCase();
    const refLower = referrer === ZERO_ADDRESS ? null : referrer.toLowerCase();
    await this.recordPlayerReferrer(playerLower, refLower);
  }

  async handleRewardsWithdrawn(referrer: `0x${string}`, amount: bigint) {
    const refLower = referrer.toLowerCase();
    const amountStr = amount.toString();

    await this.db.referralReward.upsert({
      where: { address: refLower },
      update: {
        pending: { decrement: amountStr },
        claimed: { increment: amountStr },
        updatedAt: new Date(),
      },
      create: {
        address: refLower,
        pending: "0",
        claimed: amountStr,
        updatedAt: new Date(),
      },
    });
  }

  private computeReferralAmount(wager: bigint, netStake: bigint): bigint {
    if (this.referralBps === 0n) {
      return 0n;
    }
    const houseFee = (wager * this.houseEdgeBps) / BPS_DENOMINATOR;
    const potential = wager - netStake - houseFee;
    if (potential <= 0n) {
      return 0n;
    }
    return potential;
  }

  private async buildChain(player: string): Promise<ChainEntry[]> {
    const chain: ChainEntry[] = [];
    if (this.levelBps.length === 0) {
      return chain;
    }

    let current = await this.getReferrer(player);
    for (let level = 0; level < this.levelBps.length && current; level++) {
      const levelBps = this.levelBps[level];
      if (current === null) {
        break;
      }

      if (levelBps > 0n) {
        chain.push({ address: current, level, bps: levelBps });
      }

      current = await this.getReferrer(current);
    }

    return chain;
  }

  private allocateShares(
    referralAmount: bigint,
    chain: ChainEntry[]
  ): ContributionEntry[] {
    if (chain.length === 0) {
      return [];
    }

    const totalBps = chain.reduce((acc, entry) => acc + entry.bps, 0n);
    if (totalBps === 0n) {
      return [];
    }

    const contributions: ContributionEntry[] = [];
    let remaining = referralAmount;

    for (let index = 0; index < chain.length; index++) {
      const entry = chain[index];
      let share: bigint;
      if (index === chain.length - 1) {
        share = remaining;
      } else {
        share = (referralAmount * entry.bps) / totalBps;
        if (share > remaining) {
          share = remaining;
        }
      }

      if (share > 0n) {
        contributions.push({
          referrer: entry.address,
          level: entry.level,
          amount: share,
        });
        remaining -= share;
      }
    }

    if (remaining > 0n && contributions.length > 0) {
      contributions[contributions.length - 1].amount += remaining;
    }

    return contributions;
  }

  private async persistContributions(
    payload: SpinContext,
    contributions: ContributionEntry[]
  ) {
    if (contributions.length === 0) {
      return;
    }

    const requestId = payload.requestId;
    const txHash = payload.txHash.toLowerCase();
    const blockNumber = payload.blockNumber;

    await this.db.$transaction(async (prisma) => {
      for (const entry of contributions) {
        const refLower = entry.referrer.toLowerCase();
        const amountStr = entry.amount.toString();

        await prisma.referralContribution.upsert({
          where: {
            requestId_level: {
              requestId,
              level: entry.level,
            },
          },
          update: {
            referrer: refLower,
            amount: amountStr,
            txHash,
            blockNumber,
          },
          create: {
            player: payload.player.toLowerCase(),
            referrer: refLower,
            level: entry.level,
            amount: amountStr,
            requestId,
            txHash,
            blockNumber,
          },
        });

        await prisma.referralReward.upsert({
          where: { address: refLower },
          update: {
            pending: { increment: amountStr },
            updatedAt: new Date(),
          },
          create: {
            address: refLower,
            pending: amountStr,
            claimed: "0",
            updatedAt: new Date(),
          },
        });
      }
    });
  }

  private async recordPlayerReferrer(player: string, referrer: string | null) {
    const normalizedPlayer = player.toLowerCase();
    const normalizedReferrer = referrer ? referrer.toLowerCase() : null;

    await this.db.player.upsert({
      where: { address: normalizedPlayer },
      update: { referrer: normalizedReferrer },
      create: { address: normalizedPlayer, referrer: normalizedReferrer },
    });

    await this.db.referralEdge.upsert({
      where: { player: normalizedPlayer },
      update: { referrer: normalizedReferrer, assignedAt: new Date() },
      create: { player: normalizedPlayer, referrer: normalizedReferrer },
    });
  }

  private async getReferrer(address: string): Promise<string | null> {
    try {
      const referrer = (await this.client.readContract({
        address: this.contracts.referralAddress,
        abi: this.contracts.referralAbi,
        functionName: "getReferrer",
        args: [address as `0x${string}`],
      })) as unknown as `0x${string}`;

      if (!referrer || referrer === ZERO_ADDRESS) {
        return null;
      }
      return referrer.toLowerCase();
    } catch (error) {
      console.error("Failed to read referrer", error);
      return null;
    }
  }
}
