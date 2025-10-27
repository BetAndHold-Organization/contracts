import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createWalletClient,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  parseEventLogs,
  zeroAddress,
} from "viem";
import { encodeAbiParameters } from "viem";
import type { Address } from "viem";
import { hardhat } from "viem/chains";

import { loadDeployment } from "../lib/deployments";
import { getPublicClient } from "../lib/rpcClient";
import { getGraphQLClient } from "../lib/graphqlClient";
import { REFERRAL_TREE_QUERY, REFERRAL_CONTRIBUTIONS_QUERY } from "./queries";

const NETWORK = import.meta.env.VITE_NETWORK ?? "local";
const RPC_URL = import.meta.env.VITE_RPC_URL ?? "http://localhost:8545";

export const BPS = 10_000n;
const MAX_DERIVED_ROLLS = 7;

const ROULETTE_ABI = parseAbi([
  "function getTableConfig() view returns ((bool enabled,uint16 replayBps,uint16 jackpotBps,uint16 jackpotContributionBps,uint16 minMultiplier,uint16 maxMultiplier,uint256 minWager,uint256 maxWager))",
  "function getTableConfig(uint256 index) view returns ((bool enabled,uint16 replayBps,uint16 jackpotBps,uint16 jackpotContributionBps,uint16 minMultiplier,uint16 maxMultiplier,uint256 minWager,uint256 maxWager))",
  "function getJackpotScalingConfig() view returns ((bool enabled,uint16 minJackpotBps,uint16 maxJackpotBps,uint256 minJackpotWager,uint256 maxJackpotWager,uint8 functionId,bytes extraData))",
  "function getJackpotScalingConfig(uint256 index) view returns ((bool enabled,uint16 minJackpotBps,uint16 maxJackpotBps,uint256 minJackpotWager,uint256 maxJackpotWager,uint8 functionId,bytes extraData))",
  "function previewSpin(uint256 wager,uint256 multiplierHundredths,uint32 configIndex) view returns (uint16 multiplierProbability,uint16 replayProbability,uint16 jackpotProbability,uint16 loseProbability,uint256 maxPayout,uint256 jackpotContribution)",
  "function startSpin(uint256 wager,uint256 multiplierHundredths,address potentialReferrer)",
  "function pendingSpins(uint256 requestId) view returns (address player,uint256 wager,uint256 netStake,uint256 maxPayout,uint256 jackpotContribution,uint24 multiplierHundredths,uint16 multiplierBps,uint16 jackpotBps,uint16 replayBps,uint32 configIndex,bool exists)",
  "event SpinStarted(uint256 indexed requestId,address indexed player,uint256 wager,uint256 netStake,uint256 multiplierHundredths,uint256 maxPayout,uint256 jackpotContribution,uint32 configIndex)",
]);

const TOKEN_ABI = parseAbi([
  "function approve(address spender,uint256 value) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const COORDINATOR_ABI = parseAbi([
  "function fulfill(address randomProvider,uint256 requestId,uint256[] randomWords)",
]);

const JACKPOT_ABI = parseAbi([
  "function PROBABILITY_PRECISION() view returns (uint256)",
  "function getJackpotBalance() view returns (uint256)",
  "function getJackpotState() view returns (uint8 nextTierIndex,uint256 totalEntries,uint256 totalJackpotsWon,uint256 totalConsolationPaid,address lastWinner,uint256 lastWinTimestamp)",
  "function getTierLadder() view returns ((uint256 prizeMetric,bool isTerminal,bool isPercent,uint256 fixedBetCost,bool useDynamicCost)[])",
  "function getGameOutcomes(address game) view returns ((uint256 cumulativeProbability,uint8 tierAdvance,uint8 tierResetTo,uint16 consolationMultiplier,bool awardsTier)[])",
  "function getDirectBetOutcomes() view returns ((uint256 cumulativeProbability,uint8 tierAdvance,uint8 tierResetTo,uint16 consolationMultiplier,bool awardsTier)[])",
]);

type TableConfig = {
  enabled: boolean;
  replayBps: number;
  jackpotBps: number;
  jackpotContributionBps: number;
  minMultiplier: number;
  maxMultiplier: number;
  minWager: bigint;
  maxWager: bigint;
};

type JackpotScalingConfig = {
  enabled: boolean;
  minJackpotBps: number;
  maxJackpotBps: number;
  minJackpotWager: bigint;
  maxJackpotWager: bigint;
  functionId: number;
  functionName: string;
  extraData: string;
};

export type JackpotOutcome = {
  cumulativeProbability: number;
  tierAdvance: number;
  tierResetTo: number;
  consolationMultiplier: number;
  awardsTier: boolean;
  probabilityBps: number;
};

type ReferralTreeNode = {
  address: string;
  referrer: string | null;
  level: number;
};

type ReferralContributionEntry = {
  id: string;
  player: string;
  referrer: string | null;
  level: number;
  amount: string;
  requestId: string;
  txHash: string;
  blockNumber: string;
  createdAt: string;
};

type ReferralContributionSummary = {
  asPlayer: ReferralContributionEntry[];
  asReferrer: ReferralContributionEntry[];
};

export type SpinPreview = {
  multiplierBps: number;
  replayBps: number;
  jackpotBps: number;
  loseBps: number;
  maxPayout: bigint;
  jackpotContribution: bigint;
};

type StartSpinInput = {
  account: Address;
  wager: bigint;
  multiplier: bigint;
  referrer: Address;
};

type FulfillInput = {
  account: Address;
  requestId: bigint;
  randomWord?: bigint;
};

function toTableConfig(raw: any): TableConfig {
  return {
    enabled: Boolean(raw.enabled ?? raw[0]),
    replayBps: Number(raw.replayBps ?? raw[1]),
    jackpotBps: Number(raw.jackpotBps ?? raw[2]),
    jackpotContributionBps: Number(raw.jackpotContributionBps ?? raw[3]),
    minMultiplier: Number(raw.minMultiplier ?? raw[4]),
    maxMultiplier: Number(raw.maxMultiplier ?? raw[5]),
    minWager: BigInt(raw.minWager ?? raw[6] ?? 0n),
    maxWager: BigInt(raw.maxWager ?? raw[7] ?? 0n),
  };
}

function getWalletClient(account: Address) {
  return createWalletClient({
    chain: hardhat,
    transport: http(RPC_URL),
    account,
  });
}

const BASE_ROLL_COUNT = 6;

export function deriveRolls(seed: bigint, jackpotCap: bigint): bigint[] {
  const includeJackpot = jackpotCap > 0n;
  const totalRolls = includeJackpot ? BASE_ROLL_COUNT + 1 : BASE_ROLL_COUNT;

  console.log("deriveRolls", {
    seed: seed.toString(),
    jackpotCap: jackpotCap.toString(),
    includeJackpot,
  });

  const baseRolls: bigint[] = [];
  let jackpotRoll: bigint | undefined;
  let working = seed;

  for (let i = 0; i < totalRolls; i++) {
    const divisor = i < BASE_ROLL_COUNT ? BPS : jackpotCap;
    const roll = working % divisor;
    if (i < BASE_ROLL_COUNT) {
      baseRolls.push(roll);
    } else {
      jackpotRoll = roll;
    }

    const encoded = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [working, BigInt(i)]);
    working = BigInt(keccak256(encoded));
  }

  if (includeJackpot && jackpotRoll !== undefined) {
    console.log("deriveRolls jackpot", {
      seed: seed.toString(),
      jackpotCap: jackpotCap.toString(),
      jackpotRoll: jackpotRoll.toString(),
    });
    return baseRolls.concat(jackpotRoll);
  }

  return baseRolls;
}

export function findSeed(predicate: (rolls: bigint[]) => boolean, jackpotCap: bigint): bigint {
  for (let seed = 1n; seed < 10_000_000n; seed++) {
    const rolls = deriveRolls(seed, jackpotCap);
    if (predicate(rolls)) {
      return seed;
    }
  }
  throw new Error("Seed not found");
}

export type PendingSpin = {
  player: Address;
  wager: bigint;
  netStake: bigint;
  maxPayout: bigint;
  jackpotContribution: bigint;
  multiplierHundredths: number;
  multiplierBps: bigint;
  jackpotBps: bigint;
  replayBps: bigint;
  configIndex: number;
  exists: boolean;
};

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string" && value.length > 0) return BigInt(value);
  return 0n;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.length > 0) return Number(value);
  return 0;
}

function toAddress(value: unknown): Address {
  if (typeof value === "string") return getAddress(value);
  return zeroAddress;
}

export async function fetchPendingSpin(requestId: bigint): Promise<PendingSpin> {
  const [deployment, client] = await Promise.all([loadDeployment(NETWORK), Promise.resolve(getPublicClient())]);
  const raw = await client.readContract({
    address: getAddress(deployment.roulette),
    abi: ROULETTE_ABI,
    functionName: "pendingSpins",
    args: [requestId],
  });

  const pending: any = raw;

  const player = toAddress(pending.player ?? pending[0]);
  const wager = toBigInt(pending.wager ?? pending[1]);
  const netStake = toBigInt(pending.netStake ?? pending[2]);
  const maxPayout = toBigInt(pending.maxPayout ?? pending[3]);
  const jackpotContribution = toBigInt(pending.jackpotContribution ?? pending[4]);
  const multiplierHundredths = toNumber(pending.multiplierHundredths ?? pending[5]);
  const multiplierBps = toBigInt(pending.multiplierBps ?? pending[6]);
  const jackpotBps = toBigInt(pending.jackpotBps ?? pending[7]);
  const replayBps = toBigInt(pending.replayBps ?? pending[8]);
  const configIndex = toNumber(pending.configIndex ?? pending[9]);
  const exists = Boolean(pending.exists ?? pending[10]);

  console.log("fetchPendingSpin", {
    requestId: requestId.toString(),
    player,
    wager: wager.toString(),
    netStake: netStake.toString(),
    maxPayout: maxPayout.toString(),
    jackpotContribution: jackpotContribution.toString(),
    multiplierHundredths,
    multiplierBps: multiplierBps.toString(),
    jackpotBps: jackpotBps.toString(),
    replayBps: replayBps.toString(),
    configIndex,
    exists,
  });

  return {
    player,
    wager,
    netStake,
    maxPayout,
    jackpotContribution,
    multiplierHundredths,
    multiplierBps,
    jackpotBps,
    replayBps,
    configIndex,
    exists,
  };
}

export async function fetchTableConfigByIndex(index: number) {
  const [deployment, client] = await Promise.all([loadDeployment(NETWORK), Promise.resolve(getPublicClient())]);
  const [rawConfig, rawScaling] = await Promise.all([
    client.readContract({
      address: getAddress(deployment.roulette),
      abi: ROULETTE_ABI,
      functionName: "getTableConfig",
      args: [BigInt(index)],
    }),
    client.readContract({
      address: getAddress(deployment.roulette),
      abi: ROULETTE_ABI,
      functionName: "getJackpotScalingConfig",
      args: [BigInt(index)],
    }),
  ]);
  const config = toTableConfig(rawConfig);
  const scaling = toJackpotScalingConfig(rawScaling);
  console.log("fetchTableConfig", {
    index,
    enabled: config.enabled,
    replayBps: Number(config.replayBps),
    jackpotBps: Number(config.jackpotBps),
    jackpotContributionBps: Number(config.jackpotContributionBps),
    minMultiplier: Number(config.minMultiplier),
    maxMultiplier: Number(config.maxMultiplier),
    minWager: config.minWager.toString(),
    maxWager: config.maxWager.toString(),
    scaling,
  });
  return { config, scaling };
}

const CURRENT_CONFIG_SENTINEL = (BigInt(1) << 32n) - 1n;

export async function previewSpin(
  wager: bigint,
  multiplierHundredths: bigint,
  configIndex: number = -1,
): Promise<SpinPreview> {
  const indexParam = configIndex < 0 ? CURRENT_CONFIG_SENTINEL : BigInt(configIndex);
  const [deployment, client] = await Promise.all([loadDeployment(NETWORK), Promise.resolve(getPublicClient())]);
  const result = await client.readContract({
    address: getAddress(deployment.roulette),
    abi: ROULETTE_ABI,
    functionName: "previewSpin",
    args: [wager, multiplierHundredths, indexParam],
  });

  const multiplierProbability = Number((result as any).multiplierProbability ?? result[0] ?? 0);
  const replayProbability = Number((result as any).replayProbability ?? result[1] ?? 0);
  const jackpotProbability = Number((result as any).jackpotProbability ?? result[2] ?? 0);
  const loseProbability = Number((result as any).loseProbability ?? result[3] ?? 0);
  const maxPayout = BigInt((result as any).maxPayout ?? result[4] ?? 0n);
  const jackpotContribution = BigInt((result as any).jackpotContribution ?? result[5] ?? 0n);

  return {
    multiplierBps: multiplierProbability,
    replayBps: replayProbability,
    jackpotBps: jackpotProbability,
    loseBps: loseProbability,
    maxPayout,
    jackpotContribution,
  };
}

export async function fetchJackpotCap() {
  const [deployment, client] = await Promise.all([loadDeployment(NETWORK), Promise.resolve(getPublicClient())]);
  const jackpotAddress = deployment.jackpot;
  if (!jackpotAddress || jackpotAddress === zeroAddress) {
    console.log("fetchJackpotCap", { jackpotAddress, cap: "0" });
    return 0n;
  }

  try {
    const cap = await client.readContract({
      address: getAddress(jackpotAddress),
      abi: JACKPOT_ABI,
      functionName: "PROBABILITY_PRECISION",
    });
    console.log("fetchJackpotCap", { jackpotAddress, cap: cap.toString() });
    return cap as bigint;
  } catch (error) {
    console.error("fetchJackpotCap error", error);
    return 0n;
  }
}

export function useHardhatAccounts() {
  return useQuery<Address[], Error>({
    queryKey: ["hardhat-accounts", NETWORK],
    queryFn: async () => {
      const client = getPublicClient();
      const accounts = (await client.request({ method: "eth_accounts" })) as string[];
      return accounts.map((address) => getAddress(address));
    },
    refetchInterval: 30_000,
  });
}

type TableConfigWithScaling = {
  config: TableConfig;
  scaling: JackpotScalingConfig;
};

export function useTableConfig() {
  return useQuery<TableConfigWithScaling, Error>({
    queryKey: ["roulette-config", NETWORK],
    queryFn: async () => {
      const [deployment, client] = await Promise.all([loadDeployment(NETWORK), Promise.resolve(getPublicClient())]);
      const [rawConfig, rawScaling] = await Promise.all([
        client.readContract({
          address: getAddress(deployment.roulette),
          abi: ROULETTE_ABI,
          functionName: "getTableConfig",
        }),
        client.readContract({
          address: getAddress(deployment.roulette),
          abi: ROULETTE_ABI,
          functionName: "getJackpotScalingConfig",
        }),
      ]);
      return {
        config: toTableConfig(rawConfig),
        scaling: toJackpotScalingConfig(rawScaling),
      };
    },
    refetchInterval: 60_000,
  });
}

export function useApproveHandler() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ account, amount }: { account: Address; amount: bigint }) => {
      const [deployment, publicClient] = await Promise.all([loadDeployment(NETWORK), Promise.resolve(getPublicClient())]);
      const walletClient = getWalletClient(account);
      const hash = await walletClient.writeContract({
        address: getAddress(deployment.token),
        abi: TOKEN_ABI,
        functionName: "approve",
        args: [getAddress(deployment.handler), amount],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      return hash;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["treasury-balances"] });
    },
  });
}

export function useStartSpin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ account, wager, multiplier, referrer }: StartSpinInput) => {
      const [deployment, publicClient] = await Promise.all([loadDeployment(NETWORK), Promise.resolve(getPublicClient())]);
      const tokenAddress = getAddress(deployment.token);
      const handlerAddress = getAddress(deployment.handler);
      const walletClient = getWalletClient(account);
      const allowance = await publicClient.readContract({
        address: tokenAddress,
        abi: TOKEN_ABI,
        functionName: "allowance",
        args: [account, handlerAddress],
      });
      if (allowance < wager) {
        throw new Error(
          `Insufficient EVA allowance. Approved ${allowance.toString()} wei, need ${wager.toString()} wei. Run Approve Handler first.`,
        );
      }
      const hash = await walletClient.writeContract({
        address: getAddress(deployment.roulette),
        abi: ROULETTE_ABI,
        functionName: "startSpin",
        args: [wager, multiplier, referrer],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const logs = parseEventLogs({
        abi: ROULETTE_ABI,
        logs: receipt.logs,
        eventName: "SpinStarted",
      });
      const requestId = logs[0]?.args?.requestId as bigint | undefined;
      return {
        hash,
        requestId: requestId ? requestId.toString() : null,
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["metrics"] });
      queryClient.invalidateQueries({ queryKey: ["players"] });
      queryClient.invalidateQueries({ queryKey: ["treasury-balances"] });
    },
  });
}

export function useFulfillRandomness() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ account, requestId, randomWord }: FulfillInput) => {
      const [deployment, publicClient] = await Promise.all([loadDeployment(NETWORK), Promise.resolve(getPublicClient())]);
      const walletClient = getWalletClient(account);
      const word = randomWord ?? BigInt(crypto.getRandomValues(new Uint32Array(8))[0]);
      const hash = await walletClient.writeContract({
        address: getAddress(deployment.coordinator),
        abi: COORDINATOR_ABI,
        functionName: "fulfill",
        args: [getAddress(deployment.randomProvider), requestId, [word]],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      return { hash, randomWord: word };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["metrics"] });
      queryClient.invalidateQueries({ queryKey: ["players"] });
      queryClient.invalidateQueries({ queryKey: ["player-bets"] });
      queryClient.invalidateQueries({ queryKey: ["treasury-balances"] });
    },
  });
}

export function parseWager(value: string): bigint {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Wager amount is required");
  }
  return parseEther(trimmed);
}

export function toAddressOrZero(value: string): Address {
  const trimmed = value.trim();
  if (!trimmed) return zeroAddress;
  return getAddress(trimmed as Address);
}

type JackpotState = {
  nextTierIndex: number;
  totalEntries: bigint;
  totalJackpotsWon: bigint;
  totalConsolationPaid: bigint;
  lastWinner: Address;
  lastWinTimestamp: bigint;
};

type JackpotTier = {
  prizeMetric: bigint;
  isTerminal: boolean;
  isPercent: boolean;
  fixedBetCost: bigint;
  useDynamicCost: boolean;
  cost: bigint;
  prizeAmount: bigint;
};

function toJackpotState(raw: any): JackpotState {
  return {
    nextTierIndex: Number(raw.nextTierIndex ?? raw[0] ?? 0),
    totalEntries: toBigInt(raw.totalEntries ?? raw[1] ?? 0n),
    totalJackpotsWon: toBigInt(raw.totalJackpotsWon ?? raw[2] ?? 0n),
    totalConsolationPaid: toBigInt(raw.totalConsolationPaid ?? raw[3] ?? 0n),
    lastWinner: getAddress((raw.lastWinner ?? raw[4] ?? zeroAddress) as Address),
    lastWinTimestamp: toBigInt(raw.lastWinTimestamp ?? raw[5] ?? 0n),
  };
}

function toJackpotTier(raw: any): JackpotTier {
  return {
    prizeMetric: toBigInt(raw.prizeMetric ?? raw[0] ?? 0n),
    isTerminal: Boolean(raw.isTerminal ?? raw[1]),
    isPercent: Boolean(raw.isPercent ?? raw[2]),
    fixedBetCost: toBigInt(raw.fixedBetCost ?? raw[3] ?? 0n),
    useDynamicCost: Boolean(raw.useDynamicCost ?? raw[4]),
    cost: 0n,
    prizeAmount: 0n,
  };
}

function computePrizeAmount(tier: JackpotTier, balance: bigint): bigint {
  if (!tier.isPercent) {
    return tier.prizeMetric;
  }
  if (tier.prizeMetric > 10_000n) {
    return 0n;
  }
  let amount = (balance * tier.prizeMetric) / 10_000n;
  if (tier.isTerminal) {
    const cap = (balance * 90n) / 100n;
    if (amount > cap) {
      amount = cap;
    }
  }
  return amount;
}

function computeTierCost(tier: JackpotTier, balance: bigint): bigint {
  if (!tier.useDynamicCost) {
    return tier.fixedBetCost;
  }
  return computePrizeAmount(tier, balance);
}

export async function fetchJackpotState(): Promise<JackpotState | null> {
  const [deployment, client] = await Promise.all([loadDeployment(NETWORK), Promise.resolve(getPublicClient())]);
  const jackpotAddress = deployment.jackpot;
  if (!jackpotAddress || jackpotAddress === zeroAddress) {
    return null;
  }
  try {
    const raw = await client.readContract({
      address: getAddress(jackpotAddress),
      abi: JACKPOT_ABI,
      functionName: "getJackpotState",
    });
    return toJackpotState(raw);
  } catch (error) {
    console.error("fetchJackpotState error", error);
    return null;
  }
}

export async function fetchJackpotTiers(): Promise<JackpotTier[] | null> {
  const [deployment, client] = await Promise.all([loadDeployment(NETWORK), Promise.resolve(getPublicClient())]);
  const jackpotAddress = deployment.jackpot;
  if (!jackpotAddress || jackpotAddress === zeroAddress) {
    return null;
  }
  try {
    const [rawTiers, balance] = await Promise.all([
      client.readContract({
        address: getAddress(jackpotAddress),
        abi: JACKPOT_ABI,
        functionName: "getTierLadder",
      }),
      client.readContract({
        address: getAddress(jackpotAddress),
        abi: JACKPOT_ABI,
        functionName: "getJackpotBalance",
      }),
    ]);
    const tiers = Array.isArray(rawTiers) ? rawTiers.map(toJackpotTier) : [];
    return tiers.map((tier) => {
      const prize = computePrizeAmount(tier, balance as bigint);
      const cost = computeTierCost(tier, balance as bigint);
      return { ...tier, prizeAmount: prize, cost };
    });
  } catch (error) {
    console.error("fetchJackpotTiers error", error);
    return null;
  }
}

export async function fetchJackpotOutcomes(gameAddress?: Address): Promise<JackpotOutcome[] | null> {
  const [deployment, client] = await Promise.all([loadDeployment(NETWORK), Promise.resolve(getPublicClient())]);
  const jackpotAddress = deployment.jackpot;
  if (!jackpotAddress || jackpotAddress === zeroAddress) {
    return null;
  }

  const game = gameAddress ?? getAddress(deployment.roulette);

  try {
    const rawOutcomes = await client.readContract({
      address: getAddress(jackpotAddress),
      abi: JACKPOT_ABI,
      functionName: "getGameOutcomes",
      args: [game],
    });

    let previous = 0;
    return (rawOutcomes as any[]).map((entry: any) => {
      const cumulative = Number(entry.cumulativeProbability ?? entry[0] ?? 0);
      const probabilityBps = cumulative - previous;
      previous = cumulative;
      return {
        cumulativeProbability: cumulative,
        tierAdvance: Number(entry.tierAdvance ?? entry[1] ?? 0),
        tierResetTo: Number(entry.tierResetTo ?? entry[2] ?? 0),
        consolationMultiplier: Number(entry.consolationMultiplier ?? entry[3] ?? 0),
        awardsTier: Boolean(entry.awardsTier ?? entry[4] ?? false),
        probabilityBps,
      } satisfies JackpotOutcome;
    });
  } catch (error) {
    console.error("fetchJackpotOutcomes error", error);
    return null;
  }
}

export async function fetchDirectBetOutcomes(): Promise<JackpotOutcome[] | null> {
  const [deployment, client] = await Promise.all([loadDeployment(NETWORK), Promise.resolve(getPublicClient())]);
  const jackpotAddress = deployment.jackpot;
  if (!jackpotAddress || jackpotAddress === zeroAddress) {
    return null;
  }

  try {
    const rawOutcomes = await client.readContract({
      address: getAddress(jackpotAddress),
      abi: JACKPOT_ABI,
      functionName: "getDirectBetOutcomes",
    });

    let previous = 0;
    const outcomes = (rawOutcomes as any[]).map((entry: any) => {
      const cumulative = Number(entry.cumulativeProbability ?? entry[0] ?? 0);
      const probabilityBps = cumulative - previous;
      previous = cumulative;
      return {
        cumulativeProbability: cumulative,
        tierAdvance: Number(entry.tierAdvance ?? entry[1] ?? 0),
        tierResetTo: Number(entry.tierResetTo ?? entry[2] ?? 0),
        consolationMultiplier: Number(entry.consolationMultiplier ?? entry[3] ?? 0),
        awardsTier: Boolean(entry.awardsTier ?? entry[4] ?? false),
        probabilityBps,
      } satisfies JackpotOutcome;
    });
    console.log("fetchDirectBetOutcomes", {
      jackpot: jackpotAddress,
      count: outcomes.length,
      lastCumulative: outcomes[outcomes.length - 1]?.cumulativeProbability ?? 0,
    });
    return outcomes;
  } catch (error) {
    console.error("fetchDirectBetOutcomes error", error);
    return null;
  }
}

export function useJackpotState() {
  return useQuery<JackpotState | null, Error>({
    queryKey: ["jackpot-state", NETWORK],
    queryFn: fetchJackpotState,
    refetchInterval: 60_000,
  });
}

export function useJackpotTiers() {
  return useQuery<JackpotTier[] | null, Error>({
    queryKey: ["jackpot-tiers", NETWORK],
    queryFn: fetchJackpotTiers,
    refetchInterval: 5 * 60_000,
  });
}

export function useJackpotOutcomes(game?: Address) {
  return useQuery<JackpotOutcome[] | null, Error>({
    queryKey: ["jackpot-outcomes", NETWORK, game ?? "default"],
    queryFn: () => fetchJackpotOutcomes(game),
    refetchInterval: 5 * 60_000,
  });
}

export function useDirectBetOutcomes() {
  return useQuery<JackpotOutcome[] | null, Error>({
    queryKey: ["direct-bet-outcomes", NETWORK],
    queryFn: fetchDirectBetOutcomes,
    refetchInterval: 5 * 60_000,
  });
}

export function useReferralTree(address: string | null, depth: number) {
  return useQuery<ReferralTreeNode[], Error>({
    queryKey: ["referral-tree", NETWORK, address, depth],
    queryFn: async () => {
      if (!address) {
        return [];
      }
      const client = getGraphQLClient();
      const data = await client.request<{ referralTree: ReferralTreeNode[] }>(REFERRAL_TREE_QUERY, {
        address,
        depth,
      });
      return data.referralTree;
    },
    enabled: Boolean(address),
    staleTime: 30_000,
  });
}

export function useReferralContributions(address: string | null, limit: number) {
  return useQuery<ReferralContributionSummary, Error>({
    queryKey: ["referral-contributions", NETWORK, address, limit],
    queryFn: async () => {
      if (!address) {
        return { asPlayer: [], asReferrer: [] };
      }
      const client = getGraphQLClient();
      const data = await client.request<{ referralContributions: ReferralContributionSummary }>(
        REFERRAL_CONTRIBUTIONS_QUERY,
        { address, limit }
      );
      return data.referralContributions;
    },
    enabled: Boolean(address),
    staleTime: 30_000,
  });
}

function scalingFunctionName(id: number): string {
  switch (id) {
    case 0:
      return "Linear";
    case 1:
      return "Quadratic";
    case 2:
      return "Logarithmic";
    case 3:
      return "Exponential";
    default:
      return `Unknown (${id})`;
  }
}

function toJackpotScalingConfig(raw: any): JackpotScalingConfig {
  const enabled = Boolean(raw.enabled ?? raw[0]);
  const minBps = Number(raw.minJackpotBps ?? raw[1] ?? 0);
  const maxBps = Number(raw.maxJackpotBps ?? raw[2] ?? 0);
  const minWager = BigInt(raw.minJackpotWager ?? raw[3] ?? 0n);
  const maxWager = BigInt(raw.maxJackpotWager ?? raw[4] ?? 0n);
  const functionId = Number(raw.functionId ?? raw[5] ?? 0);
  const extraData = (raw.extraData ?? raw[6] ?? "0x") as string;

  return {
    enabled,
    minJackpotBps: minBps,
    maxJackpotBps: maxBps,
    minJackpotWager: minWager,
    maxJackpotWager: maxWager,
    functionId,
    functionName: scalingFunctionName(functionId),
    extraData,
  };
}


