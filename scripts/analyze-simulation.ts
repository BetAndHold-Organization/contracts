import { promises as fs } from "node:fs";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { formatEther, parseEther } from "viem";

import { network } from "hardhat";

type DeploymentInfo = {
  token: `0x${string}`;
  coordinator: `0x${string}`;
  randomProvider: `0x${string}`;
  handler: `0x${string}`;
  referral: `0x${string}`;
  jackpot: `0x${string}`;
  roulette: `0x${string}`;
  house: `0x${string}`;
  fallback: `0x${string}`;
  samplePlayer: `0x${string}`;
};

type BetRecord = {
  type: "bet";
  index: number;
  requestId: string;
  player: `0x${string}`;
  referrer: `0x${string}`;
  wager: string;
  netStake: string;
  multiplier: number;
  jackpotContribution: string;
  outcome: number | null;
  payout: string;
  jackpotPayout: string;
  spinsConsumed: number;
  failureReason: string | null;
  startTx: `0x${string}`;
  fulfillTx: `0x${string}`;
};

type SummaryRecord = {
  type: "summary";
  totalBets: number;
  distinctPlayers: number;
  totalWager: string;
  totalNetStake: string;
  totalPayout: string;
  totalJackpot: string;
  failedSpins: number;
  jackpotWins: number;
  houseRetention: string;
  netHouseResult: string;
};

type SimulationData = {
  bets: BetRecord[];
  summary: SummaryRecord | undefined;
  filePath: string;
};

const MODULE_DIR = fileURLToPath(new URL("./", import.meta.url));
const OUTPUT_DIR = new URL("./output/", import.meta.url);
const OUTPUT_PATH = fileURLToPath(OUTPUT_DIR);
const DEPLOYMENTS_PATH = new URL("./deployments/local.json", import.meta.url);

const BASIS_POINTS = 10_000n;
const DEFAULT_HOUSE_EDGE_BPS = 500n;
const DEFAULT_REFERRAL_BPS = 200n;

const INITIAL_FUNDING = {
  house: parseEther("100"),
  fallback: parseEther("100"),
  roulette: parseEther("1000") + parseEther("1000000"),
  jackpot: parseEther("30"),
  referral: 0n,
  handler: 0n,
};

function parseArguments(argv: string[]) {
  let simulationFile: string | undefined;
  let scriptSeen = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case "run":
        continue;
      case "--":
        continue;
      case "--file":
      case "-f":
        simulationFile = argv[i + 1];
        i += 1;
        continue;
      case "--network":
      case "--chain-id":
        i += 1;
        continue;
      default:
        if (arg.startsWith("--")) {
          continue;
        }

        if (!scriptSeen && /\.([tj]s|mjs|cjs)$/i.test(arg)) {
          scriptSeen = true;
          continue;
        }

        if (!simulationFile) {
          simulationFile = arg;
        }
    }
  }

  return { simulationFile };
}

function formatBigInt(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const formatted = formatEther(abs);
  return negative ? `-${formatted}` : formatted;
}

function getStructField<T = unknown>(raw: any, key: string, index: number, fallback?: T): T | undefined {
  if (raw == null) {
    return fallback;
  }

  if (!Array.isArray(raw) && typeof raw === "object" && key in raw) {
    return raw[key] as T;
  }

  if (Array.isArray(raw)) {
    return (raw[index] as T) ?? fallback;
  }

  return fallback;
}

function toBigInt(value: any, fallback: bigint = 0n): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(value);
  }
  if (typeof value === "string" && value) {
    if (value.startsWith("0x")) {
      return BigInt(value);
    }
    return BigInt(value);
  }
  return fallback;
}

function toNumber(value: any, fallback = 0): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && value !== "") {
    return Number(value);
  }
  return fallback;
}

function getPlayerNet(statsMap: Map<string, { count: number; wager: bigint; payout: bigint; jackpot: bigint }>, address: string): bigint {
  const stats = statsMap.get(address.toLowerCase());
  if (!stats) {
    return 0n;
  }
  return stats.payout + stats.jackpot - stats.wager;
}

async function resolveSimulationFile(candidate?: string): Promise<string> {
  if (candidate) {
    const attempts = new Set<string>();

    if (candidate.startsWith("file://")) {
      attempts.add(fileURLToPath(candidate));
    }

    if (isAbsolute(candidate)) {
      attempts.add(candidate);
    } else {
      attempts.add(resolvePath(process.cwd(), candidate));
      attempts.add(resolvePath(OUTPUT_PATH, candidate));
      attempts.add(resolvePath(MODULE_DIR, candidate));
    }

    const attemptList = Array.from(attempts);

    for (let index = 0; index < attemptList.length; index += 1) {
      const attempt = attemptList[index];
      try {
        await fs.access(attempt);
        return attempt;
      } catch (error) {
        if (index === attemptList.length - 1) {
          throw new Error(`Unable to access simulation file '${candidate}': ${error}`);
        }
      }
    }
  }

  const entries = await fs.readdir(OUTPUT_PATH, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  if (files.length === 0) {
    throw new Error("No simulation output files found. Run the simulator first or provide a file path.");
  }

  files.sort((a, b) => (a.name < b.name ? 1 : -1));
  const latest = files[0];
  return resolvePath(OUTPUT_PATH, latest.name);
}

async function loadSimulationData(filePath: string): Promise<SimulationData> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const bets: BetRecord[] = [];
  let summary: SummaryRecord | undefined;

  for (const line of lines) {
    const parsed = JSON.parse(line) as BetRecord | SummaryRecord;
    if (parsed.type === "bet") {
      bets.push(parsed as BetRecord);
    } else if (parsed.type === "summary") {
      summary = parsed as SummaryRecord;
    }
  }

  return { bets, summary, filePath };
}

async function main() {
  const { simulationFile } = parseArguments(process.argv.slice(2));
  const simulationPath = await resolveSimulationFile(simulationFile);
  const { bets, summary } = await loadSimulationData(simulationPath);

  if (bets.length === 0) {
    throw new Error("Simulation file does not contain bet entries");
  }

  const deploymentRaw = await fs.readFile(DEPLOYMENTS_PATH, "utf8");
  const deployment = JSON.parse(deploymentRaw) as DeploymentInfo;

  const connection = await network.connect();
  const viem = connection.viem;

  const token = await viem.getContractAt("EverValueCoin", deployment.token);
  const handler = await viem.getContractAt("PaymentHandler", deployment.handler);
  const referral = await viem.getContractAt("MultiLevelReferral", deployment.referral);
  const jackpot = await viem.getContractAt("ProgressiveJackpot", deployment.jackpot);
  const roulette = await viem.getContractAt("SingleRandomRoulette", deployment.roulette);

  const gameConfigRaw = await handler.read.getGameConfig([deployment.roulette]);
  const enabled = getStructField<boolean>(gameConfigRaw, "0", 0, false);
  const payoutTarget = getStructField<string>(gameConfigRaw, "1", 1, deployment.roulette);
  const feeRecipient = getStructField<string>(gameConfigRaw, "2", 2, deployment.house);
  const houseEdgeBps = toBigInt(getStructField(gameConfigRaw, "3", 3, DEFAULT_HOUSE_EDGE_BPS));
  const referralBps = toBigInt(getStructField(gameConfigRaw, "4", 4, DEFAULT_REFERRAL_BPS));

  if (!enabled) {
    console.warn("Warning: roulette game is disabled in PaymentHandler configuration");
  }
  if (payoutTarget.toLowerCase() !== deployment.roulette.toLowerCase()) {
    console.warn("Warning: payout target does not match roulette contract");
  }

  const tableConfig = await roulette.read.getTableConfig();
  const jackpotStateRaw = await jackpot.read.jackpotState();
  const tierInfoRaw = await jackpot.read.getCurrentTierInfo();
  const jackpotState = {
    nextTierIndex: toNumber(getStructField(jackpotStateRaw, "nextTierIndex", 0, 0)),
    totalEntries: toNumber(getStructField(jackpotStateRaw, "totalEntries", 1, 0)),
    totalJackpotsWon: toNumber(getStructField(jackpotStateRaw, "totalJackpotsWon", 2, 0)),
    totalConsolationPaid: toBigInt(getStructField(jackpotStateRaw, "totalConsolationPaid", 3, 0n)),
    lastWinner: getStructField<string>(jackpotStateRaw, "lastWinner", 4, "0x0000000000000000000000000000000000000000"),
    lastWinTimestamp: toNumber(getStructField(jackpotStateRaw, "lastWinTimestamp", 5, 0)),
  };

  const tierInfo = {
    tierIndex: toNumber(getStructField(tierInfoRaw, "tierIndex", 0, 0)),
    tier: {
      prizeMetric: toBigInt(getStructField(getStructField(tierInfoRaw, "tier", 1, {}), "prizeMetric", 0, 0n)),
      isTerminal: Boolean(getStructField(getStructField(tierInfoRaw, "tier", 1, {}), "isTerminal", 1, false)),
      isPercent: Boolean(getStructField(getStructField(tierInfoRaw, "tier", 1, {}), "isPercent", 2, true)),
    },
    prizeAmount: toBigInt(getStructField(tierInfoRaw, "prizeAmount", 2, 0n)),
  };

  let totalWager = 0n;
  let totalNetStake = 0n;
  let totalPayout = 0n;
  let totalJackpotPayout = 0n;
  let totalJackpotContribution = 0n;
  let totalHouseFee = 0n;
  let totalReferralFee = 0n;
  let netStakeDelta = 0n;
  let failedSpins = 0;

  const outcomeDistribution = new Map<number, { count: number; totalPayout: bigint; totalJackpot: bigint }>();
  const players = new Set<string>();
  const referrers = new Set<string>();
  const playerStats = new Map<string, { count: number; wager: bigint; payout: bigint; jackpot: bigint }>();
  let sumWager = 0n;
  let sumMultiplierHundredths = 0;

  for (const bet of bets) {
    const wager = BigInt(bet.wager);
    const netStake = BigInt(bet.netStake);
    const payout = BigInt(bet.payout);
    const jackpotPayout = BigInt(bet.jackpotPayout);
    const jackpotContribution = BigInt(bet.jackpotContribution);

    totalWager += wager;
    totalNetStake += netStake;
    totalPayout += payout;
    totalJackpotPayout += jackpotPayout;
    totalJackpotContribution += jackpotContribution;
    sumWager += wager;
    sumMultiplierHundredths += bet.multiplier;

    const houseFee = (wager * houseEdgeBps) / BASIS_POINTS;
    const referralFee = (wager * referralBps) / BASIS_POINTS;
    const expectedNetStake = wager - houseFee - referralFee;
    netStakeDelta += netStake - expectedNetStake;
    totalHouseFee += houseFee;
    totalReferralFee += referralFee;

    if (bet.failureReason) {
      failedSpins += 1;
    }

    const outcomeKey = bet.outcome ?? -1;
    const existing = outcomeDistribution.get(outcomeKey) ?? { count: 0, totalPayout: 0n, totalJackpot: 0n };
    existing.count += 1;
    existing.totalPayout += payout;
    existing.totalJackpot += jackpotPayout;
    outcomeDistribution.set(outcomeKey, existing);

    players.add(bet.player.toLowerCase());
    referrers.add(bet.referrer.toLowerCase());

    const stats = playerStats.get(bet.player) ?? { count: 0, wager: 0n, payout: 0n, jackpot: 0n };
    stats.count += 1;
    stats.wager += wager;
    stats.payout += payout;
    stats.jackpot += jackpotPayout;
    playerStats.set(bet.player, stats);
  }

  if (netStakeDelta !== 0n) {
    console.warn(`Warning: aggregated net stake differs from expected by ${formatBigInt(netStakeDelta)} EVA`);
  }

  const [
    rouletteBalance,
    jackpotBalanceToken,
    handlerBalance,
    houseBalance,
    referralBalance,
    fallbackBalance,
    jackpotPoolBalance,
  ] = await Promise.all([
    token.read.balanceOf([deployment.roulette]).then(toBigInt),
    token.read.balanceOf([deployment.jackpot]).then(toBigInt),
    token.read.balanceOf([deployment.handler]).then(toBigInt),
    token.read.balanceOf([feeRecipient as `0x${string}`]).then(toBigInt),
    token.read.balanceOf([deployment.referral]).then(toBigInt),
    token.read.balanceOf([deployment.fallback]).then(toBigInt),
    jackpot.read.getJackpotBalance().then(toBigInt),
  ]);

  const defaultReceiver = await referral.read.defaultReceiver();

  const playerSummaries = Array.from(playerStats.entries()).map(([address, stats]) => {
    const net = stats.payout + stats.jackpot - stats.wager;
    return { address, ...stats, net };
  });

  playerSummaries.sort((a, b) => (a.net === b.net ? 0 : a.net > b.net ? -1 : 1));
  const topWinners = playerSummaries.slice(0, 5);

  playerSummaries.sort((a, b) => (a.net === b.net ? 0 : a.net < b.net ? -1 : 1));
  const topLosers = playerSummaries.slice(0, 5);

  const referralAddresses = Array.from(new Set<string>([...referrers, defaultReceiver.toLowerCase()]));
  const referralRewardsFlat: Array<{ address: string; pending: bigint }> = [];

  for (const address of referralAddresses) {
    const pending = await referral.read.pendingRewards([address as `0x${string}`]);
    if (pending > 0n) {
      referralRewardsFlat.push({ address, pending });
    }
  }

  referralRewardsFlat.sort((a, b) => (a.pending === b.pending ? 0 : a.pending > b.pending ? -1 : 1));
  const topReferralRewards = referralRewardsFlat.slice(0, 5);

  const totalPendingRewards = referralRewardsFlat.reduce((acc, entry) => acc + entry.pending, 0n);

  const bigNumberComparison = <T extends bigint>(
    label: string,
    expected: T,
    actual: T,
  ) => ({ label, expected, actual, delta: actual - expected });

  const houseNetGain = getPlayerNet(playerStats, deployment.house);
  const fallbackNetGain = getPlayerNet(playerStats, deployment.fallback);
  const rouletteNetGain = getPlayerNet(playerStats, deployment.roulette);

  const expectedRouletteBalance = INITIAL_FUNDING.roulette + rouletteNetGain;
  const expectedJackpotBalance = INITIAL_FUNDING.jackpot + totalJackpotContribution - totalJackpotPayout;
  const expectedHouseBalance = INITIAL_FUNDING.house + houseNetGain;
  const expectedFallbackBalance = INITIAL_FUNDING.fallback + fallbackNetGain;
  const expectedReferralBalance = totalPendingRewards;
  const expectedHandlerBalance = INITIAL_FUNDING.handler;

  const totalWagerFloat = Number(formatEther(totalWager || 1n));
  const totalNetStakeFloat = Number(formatEther(totalNetStake || 1n));
  const realizedHouseEdge = totalWager === 0n ? 0 : Number(formatEther(totalHouseFee)) / totalWagerFloat * 100;
  const realizedReferralShare = totalWager === 0n ? 0 : Number(formatEther(totalReferralFee)) / totalWagerFloat * 100;
  const realizedJackpotContributionShare = totalNetStake === 0n
    ? 0
    : Number(formatEther(totalJackpotContribution)) / totalNetStakeFloat * 100;

  const averageWager = bets.length > 0 ? Number(formatEther(totalWager)) / bets.length : 0;
  const averageMultiplierHundredths = bets.length > 0 ? sumMultiplierHundredths / bets.length : 0;
  const averageMultiplier = averageMultiplierHundredths / 100;

  console.log("Simulation file:", basename(simulationPath));
  console.log(`Total bets: ${bets.length}`);
  console.log(`Distinct players in simulation: ${players.size}`);
  console.log(`Failed spins: ${failedSpins}`);
  if (summary) {
    console.log("Summary entry recorded in file:", summary);
  }

  console.log("\n=== Aggregated Totals ===");
  console.log(`Total wager: ${formatEther(totalWager)} EVA`);
  console.log(`Total net stake: ${formatEther(totalNetStake)} EVA`);
  console.log(`Total payouts: ${formatEther(totalPayout)} EVA`);
  console.log(`Total jackpot payouts: ${formatEther(totalJackpotPayout)} EVA`);
  console.log(`Total jackpot contributions: ${formatEther(totalJackpotContribution)} EVA`);
  console.log(`Total house fee: ${formatEther(totalHouseFee)} EVA (${realizedHouseEdge.toFixed(2)}% of wager)`);
  console.log(`Total referral fee: ${formatEther(totalReferralFee)} EVA (${realizedReferralShare.toFixed(2)}% of wager)`);
  console.log(`Jackpot contribution share of net stake: ${realizedJackpotContributionShare.toFixed(2)}%`);
  console.log(`Average wager: ${averageWager.toFixed(4)} EVA`);
  console.log(`Average multiplier requested: ${averageMultiplier.toFixed(2)}x (raw: ${averageMultiplierHundredths.toFixed(2)})`);

  console.log("\n=== Outcome Distribution ===");
  for (const [outcome, data] of outcomeDistribution.entries()) {
    const label = outcome === 0 ? "Lose" : outcome === 1 ? "Multiplier" : outcome === 2 ? "Jackpot" : "Unknown";
    console.log(
      `  ${label.padEnd(10)} -> count: ${data.count}, payouts: ${formatEther(data.totalPayout)} EVA, jackpot payouts: ${formatEther(data.totalJackpot)} EVA`
    );
  }

  console.log("\n=== Contract Balances (expected vs actual) ===");
  const balanceRows: Array<{ label: string; expected: bigint; actual: bigint }> = [
    { label: "Roulette", expected: expectedRouletteBalance, actual: rouletteBalance },
    { label: "Jackpot (token)", expected: expectedJackpotBalance, actual: jackpotBalanceToken },
    { label: "Jackpot (reported)", expected: expectedJackpotBalance, actual: jackpotPoolBalance },
    { label: "House", expected: expectedHouseBalance, actual: houseBalance },
    { label: "Referral contract", expected: expectedReferralBalance, actual: referralBalance },
    { label: "Payment handler", expected: expectedHandlerBalance, actual: handlerBalance },
    { label: "Fallback account", expected: expectedFallbackBalance, actual: fallbackBalance },
  ];

  for (const row of balanceRows) {
    const delta = row.actual - row.expected;
    console.log(
      `  ${row.label.padEnd(18)} expected: ${formatBigInt(row.expected)} EVA | actual: ${formatBigInt(row.actual)} EVA | delta: ${formatBigInt(delta)} EVA`
    );
  }

  console.log("\n=== Jackpot State ===");
  console.log(`Next tier index: ${jackpotState.nextTierIndex}`);
  console.log(`Total entries: ${jackpotState.totalEntries}`);
  console.log(`Total jackpots won: ${jackpotState.totalJackpotsWon}`);
  console.log(`Total consolation paid: ${formatEther(jackpotState.totalConsolationPaid)} EVA`);
  console.log(`Current tier prize metric: ${tierInfo.tier.prizeMetric}`);
  console.log(`Current tier is terminal: ${tierInfo.tier.isTerminal}`);

  console.log("\n=== Roulette Table Configuration ===");
  console.log(tableConfig);

  console.log("\n=== Top 5 Winners ===");
  for (const player of topWinners) {
    console.log(
      `  ${player.address} -> bets: ${player.count}, wager: ${formatEther(player.wager)} EVA, payout: ${formatEther(player.payout)} EVA, jackpot: ${formatEther(player.jackpot)} EVA, net: ${formatBigInt(player.net)} EVA`
    );
  }

  console.log("\n=== Top 5 Losers ===");
  for (const player of topLosers) {
    console.log(
      `  ${player.address} -> bets: ${player.count}, wager: ${formatEther(player.wager)} EVA, payout: ${formatEther(player.payout)} EVA, jackpot: ${formatEther(player.jackpot)} EVA, net: ${formatBigInt(player.net)} EVA`
    );
  }

  console.log("\n=== Referral Rewards (top 5 pending) ===");
  for (const entry of topReferralRewards) {
    console.log(`  ${entry.address} -> pending rewards: ${formatEther(entry.pending)} EVA`);
  }
  console.log(`Total pending rewards tracked: ${formatEther(totalPendingRewards)} EVA`);
  console.log(`Referral contract EVA balance: ${formatEther(referralBalance)} EVA`);

  console.log("\n=== Consistency Checks ===");
  const expectedReferralBalanceDelta = referralBalance - totalPendingRewards;
  if (expectedReferralBalanceDelta !== 0n) {
    console.log(
      `  Warning: referral contract holds ${formatBigInt(expectedReferralBalanceDelta)} EVA more than pending rewards snapshot.`
    );
  } else {
    console.log("  Referral contract balance matches pending rewards (no withdrawals yet).");
  }

  console.log(
    `  Jackpot balance difference (token vs contract view): ${formatBigInt(jackpotBalanceToken - jackpotPoolBalance)} EVA`
  );
  console.log(`  Total referral fees vs expected: ${formatBigInt(totalReferralFee - referralBalance)} EVA (should be 0 absent withdrawals)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

