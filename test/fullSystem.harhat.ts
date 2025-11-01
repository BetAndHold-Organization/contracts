import { beforeEach } from "node:test";
import { network } from "hardhat";
import { keccak256, parseEther } from "viem";
import type { ContractReturnType } from "@nomicfoundation/hardhat-viem/types";

type Viem = Awaited<ReturnType<typeof network.connect>>["viem"];
type Wallet = Awaited<ReturnType<Viem["getWalletClients"]>>[number];

let viem: Viem;
let owner: Wallet, house: Wallet, fallbackW: Wallet, player: Wallet;

let token: ContractReturnType<"EverValueCoin">;
let coordinator: ContractReturnType<"MockVRFCoordinatorV2Plus">;
let randomProvider: ContractReturnType<"RandomProvider">;
let handler: ContractReturnType<"PaymentHandler">;
let referral: ContractReturnType<"MultiLevelReferral">;
let jackpot: ContractReturnType<"ProgressiveJackpot">;
let roulette: ContractReturnType<"SingleRandomRoulette">;

const KEY_HASH = keccak256("0x01");
const SUBSCRIPTION_ID = 1n;
const CONSUMER_RANGE_LIMIT = 7n;

const REFERRAL_LADDER = [7_000, 1_200, 900, 600, 300] as const;
const HOUSE_EDGE_BPS = 500;
const REFERRAL_BPS = 200;

const DEFAULT_TABLE_CONFIG = {
  enabled: true,
  replayBps: 1_000,
  jackpotBps: 200,
  jackpotContributionBps: 200,
  minMultiplier: 101,
  maxMultiplier: 10_000,
  minWager: parseEther("1"),
  maxWager: parseEther("100"),
} as const;

const TIER_COUNT = 9;
const TIER_START_BPS = 500;
const TIER_END_BPS = 50;

function buildTierBps(): number[] {
  const step = (TIER_START_BPS - TIER_END_BPS) / (TIER_COUNT - 1);
  const out: number[] = [];
  for (let i = 0; i < TIER_COUNT; i++) out.push(Math.round(TIER_START_BPS - i * step));
  return out;
}
const TIER_BPS = buildTierBps();
const CONSOLATION1_BPS = 2_000;
const CONSOLATION2_BPS = 3_000;
const TOTAL_TIER_BPS = TIER_BPS.reduce((a, b) => a + b, 0);
const LOSE_BPS = 10_000 - (CONSOLATION1_BPS + CONSOLATION2_BPS + TOTAL_TIER_BPS);

function buildTierLadder() {
  return Array.from({ length: TIER_COUNT }, (_, i) => ({
    prizeMetric: i === TIER_COUNT - 1 ? 9_000n : 2_000n,
    isTerminal: i === TIER_COUNT - 1,
    isPercent: true,
    fixedBetCost: 0n,
    useDynamicCost: true,
  }));
}

function buildJackpotOutcomes() {
  const entries: any[] = [];
  let running = 0n;
  if (LOSE_BPS > 0) {
    running += BigInt(LOSE_BPS);
    entries.push({ cumulativeProbability: running, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false });
  }
  if (CONSOLATION1_BPS > 0) {
    running += BigInt(CONSOLATION1_BPS);
    entries.push({ cumulativeProbability: running, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 1_200, awardsTier: false });
  }
  if (CONSOLATION2_BPS > 0) {
    running += BigInt(CONSOLATION2_BPS);
    entries.push({ cumulativeProbability: running, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 1_500, awardsTier: false });
  }
  for (let i = 0; i < TIER_COUNT; i++) {
    running += BigInt(TIER_BPS[i]);
    entries.push({ cumulativeProbability: running, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  }
  if (running !== 10_000n) throw new Error(`Jackpot outcome probabilities sum to ${running}, expected 10000`);
  return entries;
}

// Direct-bet weights from your spec; normalized to 10_000 bps
const DIRECT_BET_WEIGHTS = [
  { weight: 5,  tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: false }, // Lose
  { weight: 5,  tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 1_200, awardsTier: false }, // 1.2x
  { weight: 5,  tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 1_500, awardsTier: false }, // 1.5x
  { weight: 60, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: true  }, // Tier 0
  { weight: 70, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: true  }, // Tier 1
  { weight: 40, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: true  }, // Tier 2
  { weight: 30, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: true  }, // Tier 3
  { weight: 20, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: true  }, // Tier 4
  { weight: 15, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: true  }, // Tier 5
  { weight: 13, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: true  }, // Tier 6
  { weight: 10, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: true  }, // Tier 7
  { weight: 5,  tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: true  }, // Tier 8
];
function buildDirectBetOutcomes() {
  const total = DIRECT_BET_WEIGHTS.reduce((s, e) => s + e.weight, 0);
  let running = 0n;
  return DIRECT_BET_WEIGHTS.map((e, i) => {
    const isLast = i === DIRECT_BET_WEIGHTS.length - 1;
    const raw = Math.round((e.weight / total) * 10_000);
    const bps = isLast ? Number(10_000n - running) : raw;
    running += BigInt(bps);
    return { cumulativeProbability: running, tierAdvance: e.tierAdvance, tierResetTo: e.tierResetTo, consolationMultiplier: e.consolationMultiplier, awardsTier: e.awardsTier };
  });
}

beforeEach(async () => {
  const conn = await network.connect();
  viem = conn.viem;
  [owner, house, fallbackW, player] = await viem.getWalletClients();

  token = await viem.deployContract("EverValueCoin");
  coordinator = await viem.deployContract("MockVRFCoordinatorV2Plus");
  randomProvider = await viem.deployContract("RandomProvider", [coordinator.address]);

  await randomProvider.write.setKeyHash([KEY_HASH], { account: owner.account });
  await randomProvider.write.setSubscriptionId([SUBSCRIPTION_ID], { account: owner.account });

  handler = await viem.deployContract("PaymentHandler", [token.address]);
  referral = await viem.deployContract("MultiLevelReferral", [token.address, owner.account.address]);

  await handler.write.setReferralContract([referral.address], { account: owner.account });
  await referral.write.setPaymentHandler([handler.address], { account: owner.account });
  await referral.write.setDefaultReceiver([fallbackW.account.address], { account: owner.account });
  await referral.write.setLevels([REFERRAL_LADDER.length, REFERRAL_LADDER], { account: owner.account });

  jackpot = await viem.deployContract("ProgressiveJackpot", [token.address, randomProvider.address]);
  await jackpot.write.setTierLadder([buildTierLadder()], { account: owner.account });

  roulette = await viem.deployContract("SingleRandomRoulette", [handler.address, randomProvider.address, token.address]);

  const jackpotOutcomes = buildJackpotOutcomes();
  const directBetOutcomes = buildDirectBetOutcomes();

  await handler.write.registerGame(
    [roulette.address, roulette.address, house.account.address, HOUSE_EDGE_BPS, REFERRAL_BPS],
    { account: owner.account },
  );
  await handler.write.setGameStatus([roulette.address, true], { account: owner.account });

  await randomProvider.write.setConsumerStatus([roulette.address, true, CONSUMER_RANGE_LIMIT], { account: owner.account });

  await roulette.write.setJackpot([jackpot.address], { account: owner.account });

  await jackpot.write.registerGame([roulette.address, jackpotOutcomes], { account: owner.account });
  await jackpot.write.setGameStatus([roulette.address, true], { account: owner.account });

  await jackpot.write.configureDirectBet([true, directBetOutcomes], { account: owner.account });

  await roulette.write.setTableConfig([DEFAULT_TABLE_CONFIG], { account: owner.account });

  await token.write.transfer([jackpot.address, parseEther("30")], { account: owner.account });
  await token.write.transfer([house.account.address, parseEther("100")], { account: owner.account });
  await token.write.transfer([fallbackW.account.address, parseEther("100")], { account: owner.account });
  await token.write.transfer([player.account.address, parseEther("100")], { account: owner.account });
  await token.write.transfer([roulette.address, parseEther("1000000")], { account: owner.account });
});

// Expose what you need from this scope for your tests, e.g.:
// export { token, handler, referral, jackpot, roulette, owner, house, fallbackW, player };