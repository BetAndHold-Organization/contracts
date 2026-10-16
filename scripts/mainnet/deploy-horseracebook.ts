/**
 * Deploys HorseRaceBook ("bet on a horse" mode of the Horse Race) to Arbitrum
 * One against the live V6 platform core (index.json → platform.core) and wires it up:
 *
 *   1. deploy HorseRaceBook(token, handler, randomProvider, authHub, operator, engineConfigHash)
 *   2. randomProvider.setConsumerStatus(game, true, 1)
 *   3. paymentHandler.registerGame(game, game, feeRecipient, house, referral, jackpot)
 *   4. authHub.setSpendTracker(game, true)  +  authHub.setOperator(operator, true)
 *   5. setBetLimits(minBet, maxBet, maxBetsPerRace)  (+ setSettleDeadlineSeconds)
 *   6. optional bankroll transfer
 *
 *   CONFIRM_MAINNET=yes MAINNET_HORSE_OPERATOR=0x... \
 *     npx hardhat run scripts/mainnet/deploy-horseracebook.ts --network arbitrum
 *
 * Every registration call is dry-run with `simulate` before it is sent, so a
 * selector/role mismatch against the live core fails loudly BEFORE burning gas
 * on a mystery revert. The contract address is written to
 * deployments/horseracebook-mainnet.json as soon as the deploy lands — if a later
 * step fails, fix it and finish that step by hand; do not redeploy.
 *
 * ── Soft launch defaults ────────────────────────────────────────────────
 * Bet limits default to 0.1 – 2 EVA (0.1 EVA is the platform minimum bet) and
 * 48 bets per race. The worst bankroll outflow per race is every bet at the
 * max on one lane: 48 × 2 × 0.97 × 2.4 ≈ 224 EVA — size the bankroll (or lower
 * the limits with setBetLimits) accordingly; lockRace reverts with
 * LiquidityShortfall when the bankroll cannot cover a race.
 *
 * ── Fee split ───────────────────────────────────────────────────────────
 * Defaults to 1.5 % house / 1.5 % referral / 0 % jackpot — the split the engine
 * was calibrated and tested with on Sepolia. The other V6 games are registered
 * 150/150/100; the contract reads the net stake from the PaymentHandler at lock
 * time, so any split works on-chain, but the jackpot share comes out of the
 * prize pot. Set MAINNET_HORSE_JACKPOT_BPS=100 to match the rest of the platform.
 *
 * ── Randomness ──────────────────────────────────────────────────────────
 * HorseRaceBook only talks to the RandomProvider (requestRandomNumber →
 * fulfillRandomness / handleRandomFailure), so it works with whatever
 * coordinator the provider is pointed at.
 *
 * ── Env ─────────────────────────────────────────────────────────────────
 *   CONFIRM_MAINNET=yes                 required
 *   MAINNET_HORSE_OPERATOR              required — the backend's hot wallet (gameOperator)
 *   MAINNET_HORSE_ENGINE_CONFIG_HASH    default: engine v4
 *   MAINNET_BOOK_MIN_BET / MAINNET_BOOK_MAX_BET   default: 0.1 / 2 (EVA)
 *   MAINNET_BOOK_MAX_BETS               default: 48 (bets per race, ≤ 100)
 *   MAINNET_HORSE_HOUSE_BPS / _REFERRAL_BPS / _JACKPOT_BPS   default: 150 / 150 / 0
 *   MAINNET_HORSE_SETTLE_DEADLINE_SECONDS   default: 300 (contract default is 900)
 *   MAINNET_HORSE_BANKROLL              default: "0" = skip, fund manually
 *   MAINNET_EVA_TOKEN_ADDRESS, MAINNET_PAYMENT_HANDLER_ADDRESS,
 *   MAINNET_RANDOM_PROVIDER_ADDRESS, MAINNET_AUTH_HUB_ADDRESS,
 *   MAINNET_FEE_RECIPIENT_ADDRESS       default: V6 core from index.json
 */

import { network } from "hardhat";
import { parseEther, formatEther } from "viem";
import { promises as fs } from "node:fs";
import "dotenv/config";

type Addr = `0x${string}`;
type Hash32 = `0x${string}`;

function banner(s: string) {
  console.log("\n" + "═".repeat(70));
  console.log(s);
  console.log("═".repeat(70));
}
function step(s: string) {
  console.log(`\n→ ${s}`);
}
function ok(s: string) {
  console.log(`  ✓ ${s}`);
}

function requireAddress(name: string): Addr {
  const v = (process.env[name] ?? "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new Error(`Missing or invalid env var ${name} (expected a 0x address)`);
  }
  return v as Addr;
}

function addressWithDefault(name: string, fallback: Addr): Addr {
  const v = (process.env[name] ?? "").trim();
  if (!v) return fallback;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new Error(`Invalid env var ${name} (expected a 0x address): ${v}`);
  }
  return v as Addr;
}

function bpsWithDefault(name: string, fallback: number): number {
  const v = (process.env[name] ?? "").trim();
  if (!v) return fallback;
  if (!/^\d+$/.test(v)) throw new Error(`Invalid env var ${name} (expected basis points): ${v}`);
  return Number(v);
}


// ─── V6 platform core (scripts/mainnet/deployments/index.json → platform.core) ──
const TOKEN_ADDRESS = addressWithDefault(
  "MAINNET_EVA_TOKEN_ADDRESS",
  "0x45D9831d8751B2325f3DBf48db748723726e1C8c",
);
const HANDLER = addressWithDefault(
  "MAINNET_PAYMENT_HANDLER_ADDRESS",
  "0x2a8a553451ba5c14d7a1ee4d3d7d1d2be6f819e8",
);
const RANDOM = addressWithDefault(
  "MAINNET_RANDOM_PROVIDER_ADDRESS",
  "0x6aa57111d6f5970565dc355f87aa75e1609be3d4",
);
const AUTH_HUB = addressWithDefault(
  "MAINNET_AUTH_HUB_ADDRESS",
  "0x86543287d870f30dd21320dd10451bf33e64f775",
);
const FEE_RECIPIENT = addressWithDefault(
  "MAINNET_FEE_RECIPIENT_ADDRESS",
  "0x2132c5e539F1Da6090424644576ABB5C5aDcdbbd", // "house" wallet
);

// Engine v3 (house presses at 90 % of its peak speed). Derived from the backend
// code: engineConfigHash(ENGINE_CONFIG_V1) in horseBackend/backend/src/engine/engineConfig.ts.
// The frontend verifier recomputes this hash — a different value makes every
// race fail provably-fair verification.
const DEFAULT_ENGINE_CONFIG_HASH: Hash32 =
  "0x8043770ebc7ab1e5aace82d064c4d20ad15dbf05d2b01a8e9738997cd04805b7";

const HOUSE_BPS = bpsWithDefault("MAINNET_HORSE_HOUSE_BPS", 150);
const REFERRAL_BPS = bpsWithDefault("MAINNET_HORSE_REFERRAL_BPS", 150);
const JACKPOT_BPS = bpsWithDefault("MAINNET_HORSE_JACKPOT_BPS", 0);

const MIN_BET = parseEther((process.env.MAINNET_BOOK_MIN_BET ?? "").trim() || "0.1");
const MAX_BET = parseEther((process.env.MAINNET_BOOK_MAX_BET ?? "").trim() || "2");
const MAX_BETS = Number((process.env.MAINNET_BOOK_MAX_BETS ?? "").trim() || "48");

// Seconds after lock before ANYONE may force a refund of an unsettled race.
// The backend relies on it to return stakes after a randomness timeout, so a
// short deadline means a short wait for the player. A race takes ~40 s from
// lock to settle. Contract bounds: 60 s .. 1 day.
const SETTLE_DEADLINE_SECONDS = Number(
  (process.env.MAINNET_HORSE_SETTLE_DEADLINE_SECONDS ?? "").trim() || "300",
);

const CONSUMER_RANGE_LIMIT = 1n; // one random word per race

// Unset or "0" → skip funding; fund manually once the deploy is verified.
const BANKROLL = (process.env.MAINNET_HORSE_BANKROLL ?? "").trim() || "0";

const DEPLOYMENT_FILE = new URL("./deployments/horseracebook-mainnet.json", import.meta.url);

async function main() {
  if (process.env.CONFIRM_MAINNET !== "yes") {
    throw new Error(
      "Refusing to run against mainnet without CONFIRM_MAINNET=yes. " +
        "This deploys a real contract, registers it with real infrastructure, " +
        "and optionally moves real EVA. Re-run as:\n" +
        "  CONFIRM_MAINNET=yes MAINNET_HORSE_OPERATOR=0x... " +
        "npx hardhat run scripts/mainnet/deploy-horseracebook.ts --network arbitrum",
    );
  }

  const OPERATOR = requireAddress("MAINNET_HORSE_OPERATOR");
  const ENGINE_CONFIG_HASH = ((process.env.MAINNET_HORSE_ENGINE_CONFIG_HASH ?? "").trim() ||
    DEFAULT_ENGINE_CONFIG_HASH) as Hash32;
  if (!/^0x[0-9a-fA-F]{64}$/.test(ENGINE_CONFIG_HASH) || /^0x0{64}$/.test(ENGINE_CONFIG_HASH)) {
    throw new Error(`Invalid MAINNET_HORSE_ENGINE_CONFIG_HASH: ${ENGINE_CONFIG_HASH}`);
  }
  if (!Number.isInteger(SETTLE_DEADLINE_SECONDS) || SETTLE_DEADLINE_SECONDS < 60 || SETTLE_DEADLINE_SECONDS > 86_400) {
    throw new Error("MAINNET_HORSE_SETTLE_DEADLINE_SECONDS must be an integer in [60, 86400]");
  }
  if (MIN_BET === 0n || MAX_BET < MIN_BET || !Number.isInteger(MAX_BETS) || MAX_BETS < 1 || MAX_BETS > 100) {
    throw new Error("MAINNET_BOOK_MIN_BET / MAINNET_BOOK_MAX_BET / MAINNET_BOOK_MAX_BETS out of range");
  }
  if (HOUSE_BPS + REFERRAL_BPS + JACKPOT_BPS >= 10000) {
    throw new Error("HOUSE_BPS + REFERRAL_BPS + JACKPOT_BPS must be < 10000 (PaymentHandler.MAX_BPS).");
  }

  const existing = await fs.readFile(DEPLOYMENT_FILE, "utf8").catch(() => null);
  if (existing) {
    const parsed = JSON.parse(existing);
    throw new Error(
      `HorseRaceBook already deployed at ${parsed.horseRaceBook} (${DEPLOYMENT_FILE.pathname}). ` +
        `This script is one-shot; delete that file first if you really need to redeploy.`,
    );
  }

  const conn = await network.connect();
  const viem = conn.viem;
  const networkName = conn.networkName;
  const publicClient = await viem.getPublicClient();

  if (networkName !== "arbitrum") {
    throw new Error(`This script targets --network arbitrum; got "${networkName}".`);
  }
  const chainId = await publicClient.getChainId();
  if (chainId !== 42161) {
    throw new Error(`Expected Arbitrum One (chainId 42161); connected chainId is ${chainId}.`);
  }

  const [deployer] = await viem.getWalletClients();
  const deployerAddr = deployer.account.address as Addr;
  const deployerETH = await publicClient.getBalance({ address: deployerAddr });
  const wait = (hash: `0x${string}`) => publicClient.waitForTransactionReceipt({ hash });

  const netStakeBps = 10000 - HOUSE_BPS - REFERRAL_BPS - JACKPOT_BPS;

  banner("HorseRaceBook — Arbitrum Mainnet (V6 core)");
  console.log("Network:          ", networkName, `(chainId ${chainId})`);
  console.log("Deployer (owner): ", deployerAddr);
  console.log("Deployer ETH:     ", formatEther(deployerETH), "ETH");
  console.log("Horse operator:   ", OPERATOR);
  console.log("EverValueCoin:    ", TOKEN_ADDRESS);
  console.log("PaymentHandler:   ", HANDLER);
  console.log("RandomProvider:   ", RANDOM);
  console.log("AuthHub:          ", AUTH_HUB);
  console.log("Fee recipient:    ", FEE_RECIPIENT);
  console.log("Engine config:    ", ENGINE_CONFIG_HASH);
  console.log("Bet limits (EVA): ", `${formatEther(MIN_BET)} – ${formatEther(MAX_BET)} × ${MAX_BETS} bets/race`);
  console.log(
    "Fee split:        ",
    `${HOUSE_BPS / 100}% house / ${REFERRAL_BPS / 100}% referral / ${JACKPOT_BPS / 100}% jackpot`,
    `(net stake ${netStakeBps} bps)`,
  );
  console.log("Settle deadline:  ", `${SETTLE_DEADLINE_SECONDS} s`);
  console.log(
    "Max exposure/race:",
    `${formatEther((MAX_BET * BigInt(MAX_BETS) * BigInt(netStakeBps) * 24n) / (10000n * 10n))} EVA (every bet at the max on one lane, 2.4×)`,
  );
  console.log("Bankroll:         ", BANKROLL === "0" ? "SKIPPED (fund manually after deploy)" : `${BANKROLL} EVA`);

  if (deployerETH === 0n) {
    throw new Error("Deployer has 0 ETH — cannot pay for gas.");
  }

  // ── Pre-flight ───────────────────────────────────────────────────────────
  step("Pre-flight: probing the V6 core and the deployer's roles");
  const paymentHandler = await viem.getContractAt("PaymentHandler", HANDLER);
  const randomProvider = await viem.getContractAt("RandomProvider", RANDOM);
  const authHub = await viem.getContractAt("AuthHub", AUTH_HUB);
  const token = await viem.getContractAt("EverValueCoin", TOKEN_ADDRESS);

  for (const [label, contract, address] of [
    ["PaymentHandler", paymentHandler, HANDLER],
    ["RandomProvider", randomProvider, RANDOM],
    ["AuthHub", authHub, AUTH_HUB],
  ] as const) {
    const owner = (await contract.read.owner().catch((e: unknown) => {
      throw new Error(`${label} at ${address} did not respond to owner(): ${e}`);
    })) as Addr;
    if (owner.toLowerCase() !== deployerAddr.toLowerCase()) {
      throw new Error(
        `${label} at ${address} is owned by ${owner}, not by the deployer ${deployerAddr} — ` +
          `the registration calls would revert. Run this with the platform owner's key.`,
      );
    }
  }
  ok("PaymentHandler, RandomProvider and AuthHub respond and are owned by the deployer");

  if (BANKROLL !== "0") {
    const deployerEva = (await token.read.balanceOf([deployerAddr])) as bigint;
    if (deployerEva < parseEther(BANKROLL)) {
      throw new Error(
        `Deployer EVA balance (${formatEther(deployerEva)}) is less than the requested bankroll (${BANKROLL}).`,
      );
    }
  }

  // ── 1. Deploy ────────────────────────────────────────────────────────────
  step("Deploying HorseRaceBook");
  const game = await viem.deployContract("HorseRaceBook", [
    TOKEN_ADDRESS,
    HANDLER,
    RANDOM,
    AUTH_HUB,
    OPERATOR,
    ENGINE_CONFIG_HASH,
  ]);
  const deployBlock = await publicClient.getBlockNumber();
  ok(`HorseRaceBook: ${game.address} (block ~${deployBlock})`);

  // Persist immediately: from here on a failure must never lose the address.
  const record = {
    contract: "HorseRaceBook",
    network: networkName,
    chainId,
    deployedAt: new Date().toISOString(),
    deployBlock: deployBlock.toString(),
    deployer: deployerAddr,
    horseRaceBook: game.address,
    operator: OPERATOR,
    engineConfigHash: ENGINE_CONFIG_HASH,
    infrastructure: {
      token: TOKEN_ADDRESS,
      handler: HANDLER,
      randomProvider: RANDOM,
      authHub: AUTH_HUB,
      feeRecipient: FEE_RECIPIENT,
    },
    config: {
      houseEdgeBps: HOUSE_BPS,
      referralBps: REFERRAL_BPS,
      jackpotBps: JACKPOT_BPS,
      minBetEva: formatEther(MIN_BET),
      maxBetEva: formatEther(MAX_BET),
      maxBetsPerRace: MAX_BETS,
      settleDeadlineSeconds: SETTLE_DEADLINE_SECONDS,
      lanes: 4,
    },
    wiring: "in progress",
  };
  const save = async (wiring: string) => {
    await fs.writeFile(DEPLOYMENT_FILE, JSON.stringify({ ...record, wiring }, null, 2) + "\n", "utf8");
  };
  await save("in progress");

  // ── 2. Platform registration ─────────────────────────────────────────────
  step("Registering as RandomProvider consumer (1 range per race)");
  const consumerArgs: [Addr, boolean, bigint] = [game.address, true, CONSUMER_RANGE_LIMIT];
  await randomProvider.simulate.setConsumerStatus(consumerArgs).catch((e: unknown) => {
    throw new Error(
      `setConsumerStatus reverted in simulation against the live RandomProvider at ${RANDOM}. ` +
        `HorseRaceBook IS deployed at ${game.address} — do not redeploy. Original error: ${e}`,
    );
  });
  await wait(await randomProvider.write.setConsumerStatus(consumerArgs));
  ok("Consumer registered");

  step(
    `Registering in PaymentHandler (${HOUSE_BPS / 100}% house / ${REFERRAL_BPS / 100}% referral / ${JACKPOT_BPS / 100}% jackpot)`,
  );
  const registerArgs: [Addr, Addr, Addr, number, number, number] = [
    game.address,
    game.address,
    FEE_RECIPIENT,
    HOUSE_BPS,
    REFERRAL_BPS,
    JACKPOT_BPS,
  ];
  await paymentHandler.simulate.registerGame(registerArgs).catch((e: unknown) => {
    throw new Error(
      `registerGame(${registerArgs.join(", ")}) reverted in simulation against the live PaymentHandler at ${HANDLER}. ` +
        `HorseRaceBook IS deployed at ${game.address} — do not redeploy. Original error: ${e}`,
    );
  });
  await wait(await paymentHandler.write.registerGame(registerArgs));
  ok("Registered in PaymentHandler");

  step("Registering as AuthHub spend tracker");
  await wait(await authHub.write.setSpendTracker([game.address, true]));
  ok("Spend tracker registered");

  step(`AuthHub operator allowlist: ${OPERATOR}`);
  if ((await authHub.read.isOperator([OPERATOR])) as boolean) {
    ok("Operator already allowlisted");
  } else {
    await wait(await authHub.write.setOperator([OPERATOR, true]));
    ok("Operator allowlisted");
  }

  // ── 3. Game config ───────────────────────────────────────────────────────
  step(`setBetLimits(${formatEther(MIN_BET)} EVA, ${formatEther(MAX_BET)} EVA, ${MAX_BETS})`);
  await wait(await game.write.setBetLimits([MIN_BET, MAX_BET, MAX_BETS]));
  ok("Bet limits set");

  step(`setSettleDeadlineSeconds(${SETTLE_DEADLINE_SECONDS})`);
  await wait(await game.write.setSettleDeadlineSeconds([SETTLE_DEADLINE_SECONDS]));
  // Revelación defaults come from the constructor (3 % of every pot, pays 1 in 20); shown for the record.
  const [revPool, revBps, revOdds] = (await game.read.getRevelacion()) as [bigint, number, number];
  step(`Revelación: ${revBps / 100} % de las apuestas netas al pool, lo reparte 1 de cada ${revOdds} carreras entre el carril ganador (pool ${formatEther(revPool)} EVA) — setRevelacion(bps, odds) para cambiarlo`);
  ok("Settle deadline set");

  // ── 4. Funding ───────────────────────────────────────────────────────────
  if (BANKROLL !== "0") {
    step(`Bankrolling with ${BANKROLL} EVA`);
    await wait(await token.write.transfer([game.address, parseEther(BANKROLL)]));
    ok("Bankrolled");
  }

  await save("complete");
  ok(`Deployment record: ${DEPLOYMENT_FILE.pathname}`);

  banner("DONE");
  console.log("HorseRaceBook:", game.address);
  console.log("Deploy block: ", deployBlock.toString());
  console.log("\nNext:");
  console.log("  - add \"horseRaceBook\" to the operatorsServer deployment JSON (module horseBook)");
  console.log("  - NEXT_PUBLIC_HORSE_BOOK_ADDRESS in the shell");
  console.log("  - HORSE_BOOK_ADDRESS in the horse backend .env (same operator wallet)");
  if (BANKROLL === "0") console.log("  - fund the bankroll: transfer EVA to the game address (lockRace reverts without it)");
  console.log("  - the operator wallet needs ETH for gas");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
