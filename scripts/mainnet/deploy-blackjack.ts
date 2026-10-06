/**
 * Deploys BlackjackGame to Arbitrum One against the live V6 platform core
 * (index.json → platform.core) and wires it up:
 *
 *   1. deploy BlackjackGame(token, handler, randomProvider, authHub, operator)
 *   2. randomProvider.setConsumerStatus(game, true, 1)
 *   3. paymentHandler.registerGame(game, game, feeRecipient, house, referral, jackpot)
 *   4. authHub.setSpendTracker(game, true)  +  authHub.setOperator(operator, true)
 *   5. setTableConfig(min / max / max side bet, settleTimeout, refundTimeout)
 *   6. optional bankroll transfer
 *
 *   CONFIRM_MAINNET=yes MAINNET_BLACKJACK_OPERATOR=0x... \
 *     npx hardhat run scripts/mainnet/deploy-blackjack.ts --network arbitrum
 *
 * Every registration call is dry-run with `simulate` before it is sent, so a
 * selector/role mismatch against the live core fails loudly BEFORE burning gas
 * on a mystery revert. The contract address is written to
 * deployments/blackjack-mainnet.json as soon as the deploy lands — if a later
 * step fails, fix it and finish that step by hand; do not redeploy.
 *
 * ── Soft launch defaults ────────────────────────────────────────────────
 * Table 0.1 – 1 EVA, Perfect Pairs ≤ 0.25 EVA: little money at stake while the
 * game ships unlisted (0.1 EVA is the platform minimum bet). Raise later with
 * setTableConfig — the backend re-reads the table from the chain on restart.
 * Worst-case bankroll outflow per round at the top of the table:
 * 5.5 × maxBet + 26 × maxSideBet (double or split, two hands, insurance, suited pair).
 *
 * ── Fee split ───────────────────────────────────────────────────────────
 * Defaults to 0.45 % house / 0.45 % referral / 0 % jackpot (0.9 % total): the
 * rules edge vs basic strategy is 0.88 %, and payouts are computed on GROSS
 * wagers, so the fee is paid by the game out of that edge rather than by the
 * player. The other V6 games are registered 150/150/100 — set the
 * MAINNET_BLACKJACK_*_BPS vars to match them if the platform prefers a cushion;
 * the contract works with any split (the handler retains the fee at collection
 * time, the bankroll absorbs the difference).
 *
 * ── Randomness ──────────────────────────────────────────────────────────
 * BlackjackGame only talks to the RandomProvider (requestRandomNumbers →
 * getRawWord), so it works with whatever coordinator the provider is pointed
 * at — on mainnet the platform's own coordinator, no Chainlink subscription.
 *
 * ── Env ─────────────────────────────────────────────────────────────────
 *   CONFIRM_MAINNET=yes                 required
 *   MAINNET_BLACKJACK_OPERATOR          required — the backend's hot wallet (gameOperator + AuthHub operator)
 *   MAINNET_BLACKJACK_MIN_BET / _MAX_BET / _MAX_SIDE_BET   default: 0.1 / 1 / 0.25 (EVA)
 *   MAINNET_BLACKJACK_HOUSE_BPS / _REFERRAL_BPS / _JACKPOT_BPS   default: 45 / 45 / 0
 *   MAINNET_BLACKJACK_SETTLE_TIMEOUT_SECONDS   default: 600  (operator may resolve an abandoned round)
 *   MAINNET_BLACKJACK_REFUND_TIMEOUT_SECONDS   default: 3600 (anyone may refund an unsettled round)
 *   MAINNET_BLACKJACK_BANKROLL          default: "0" = skip, fund manually
 *   MAINNET_EVA_TOKEN_ADDRESS, MAINNET_PAYMENT_HANDLER_ADDRESS,
 *   MAINNET_RANDOM_PROVIDER_ADDRESS, MAINNET_AUTH_HUB_ADDRESS,
 *   MAINNET_FEE_RECIPIENT_ADDRESS       default: V6 core from index.json
 */

import { network } from "hardhat";
import { parseEther, formatEther } from "viem";
import { promises as fs } from "node:fs";
import "dotenv/config";

type Addr = `0x${string}`;

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

function evaWithDefault(name: string, fallback: string): bigint {
  const v = (process.env[name] ?? "").trim() || fallback;
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`Invalid env var ${name} (expected an EVA amount): ${v}`);
  return parseEther(v);
}

function secondsWithDefault(name: string, fallback: number): number {
  const v = (process.env[name] ?? "").trim();
  if (!v) return fallback;
  if (!/^\d+$/.test(v)) throw new Error(`Invalid env var ${name} (expected seconds): ${v}`);
  return Number(v);
}

// ─── V6 platform core (scripts/mainnet/deployments/index.json → platform.core) ──
const TOKEN_ADDRESS = addressWithDefault("MAINNET_EVA_TOKEN_ADDRESS", "0x45D9831d8751B2325f3DBf48db748723726e1C8c");
const HANDLER = addressWithDefault("MAINNET_PAYMENT_HANDLER_ADDRESS", "0x2a8a553451ba5c14d7a1ee4d3d7d1d2be6f819e8");
const RANDOM = addressWithDefault("MAINNET_RANDOM_PROVIDER_ADDRESS", "0x6aa57111d6f5970565dc355f87aa75e1609be3d4");
const AUTH_HUB = addressWithDefault("MAINNET_AUTH_HUB_ADDRESS", "0x86543287d870f30dd21320dd10451bf33e64f775");
const FEE_RECIPIENT = addressWithDefault(
  "MAINNET_FEE_RECIPIENT_ADDRESS",
  "0x2132c5e539F1Da6090424644576ABB5C5aDcdbbd", // "house" wallet
);

const HOUSE_BPS = bpsWithDefault("MAINNET_BLACKJACK_HOUSE_BPS", 45);
const REFERRAL_BPS = bpsWithDefault("MAINNET_BLACKJACK_REFERRAL_BPS", 45);
const JACKPOT_BPS = bpsWithDefault("MAINNET_BLACKJACK_JACKPOT_BPS", 0);

const MIN_BET = evaWithDefault("MAINNET_BLACKJACK_MIN_BET", "0.1");
const MAX_BET = evaWithDefault("MAINNET_BLACKJACK_MAX_BET", "1");
const MAX_SIDE_BET = evaWithDefault("MAINNET_BLACKJACK_MAX_SIDE_BET", "0.25");
const SETTLE_TIMEOUT = secondsWithDefault("MAINNET_BLACKJACK_SETTLE_TIMEOUT_SECONDS", 600);
const REFUND_TIMEOUT = secondsWithDefault("MAINNET_BLACKJACK_REFUND_TIMEOUT_SECONDS", 3600);

const CONSUMER_RANGE_LIMIT = 1n; // one random word per round

// Unset or "0" → skip funding; fund manually once the deploy is verified.
const BANKROLL = (process.env.MAINNET_BLACKJACK_BANKROLL ?? "").trim() || "0";

const DEPLOYMENT_FILE = new URL("./deployments/blackjack-mainnet.json", import.meta.url);

async function main() {
  if (process.env.CONFIRM_MAINNET !== "yes") {
    throw new Error(
      "Refusing to run against mainnet without CONFIRM_MAINNET=yes. " +
        "This deploys a real contract, registers it with real infrastructure, " +
        "and optionally moves real EVA. Re-run as:\n" +
        "  CONFIRM_MAINNET=yes MAINNET_BLACKJACK_OPERATOR=0x... " +
        "npx hardhat run scripts/mainnet/deploy-blackjack.ts --network arbitrum",
    );
  }

  const OPERATOR = requireAddress("MAINNET_BLACKJACK_OPERATOR");
  if (HOUSE_BPS + REFERRAL_BPS + JACKPOT_BPS >= 10000) {
    throw new Error("HOUSE_BPS + REFERRAL_BPS + JACKPOT_BPS must be < 10000 (PaymentHandler.MAX_BPS).");
  }
  if (MIN_BET === 0n || MIN_BET > MAX_BET) throw new Error("MAINNET_BLACKJACK_MIN_BET must be > 0 and ≤ MAX_BET");
  if (SETTLE_TIMEOUT < 60 || REFUND_TIMEOUT <= SETTLE_TIMEOUT) {
    throw new Error("timeouts: SETTLE_TIMEOUT ≥ 60 s and REFUND_TIMEOUT > SETTLE_TIMEOUT");
  }

  const existing = await fs.readFile(DEPLOYMENT_FILE, "utf8").catch(() => null);
  if (existing) {
    const parsed = JSON.parse(existing);
    throw new Error(
      `BlackjackGame already deployed at ${parsed.blackjackGame} (${DEPLOYMENT_FILE.pathname}). ` +
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
  const maxExposure = (MAX_BET * 55n) / 10n + MAX_SIDE_BET * 26n;

  banner("BlackjackGame — Arbitrum Mainnet (V6 core)");
  console.log("Network:          ", networkName, `(chainId ${chainId})`);
  console.log("Deployer (owner): ", deployerAddr);
  console.log("Deployer ETH:     ", formatEther(deployerETH), "ETH");
  console.log("Game operator:    ", OPERATOR);
  console.log("EverValueCoin:    ", TOKEN_ADDRESS);
  console.log("PaymentHandler:   ", HANDLER);
  console.log("RandomProvider:   ", RANDOM);
  console.log("AuthHub:          ", AUTH_HUB);
  console.log("Fee recipient:    ", FEE_RECIPIENT);
  console.log("Table (EVA):      ", `${formatEther(MIN_BET)} – ${formatEther(MAX_BET)}, Perfect Pairs ≤ ${formatEther(MAX_SIDE_BET)}`);
  console.log(
    "Fee split:        ",
    `${HOUSE_BPS / 100}% house / ${REFERRAL_BPS / 100}% referral / ${JACKPOT_BPS / 100}% jackpot`,
    `(net stake ${netStakeBps} bps; payouts on gross wagers)`,
  );
  console.log("Timeouts:         ", `settle ${SETTLE_TIMEOUT} s / refund ${REFUND_TIMEOUT} s`);
  console.log("Max exposure/round:", `${formatEther(maxExposure)} EVA`);
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
  step("Deploying BlackjackGame");
  const game = await viem.deployContract("BlackjackGame", [TOKEN_ADDRESS, HANDLER, RANDOM, AUTH_HUB, OPERATOR]);
  const deployBlock = await publicClient.getBlockNumber();
  ok(`BlackjackGame: ${game.address} (block ~${deployBlock})`);

  // Persist immediately: from here on a failure must never lose the address.
  const record = {
    contract: "BlackjackGame",
    network: networkName,
    chainId,
    deployedAt: new Date().toISOString(),
    deployBlock: deployBlock.toString(),
    deployer: deployerAddr,
    blackjackGame: game.address,
    operator: OPERATOR,
    rulesVersion: Number(await game.read.RULES_VERSION()),
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
      maxSideBetEva: formatEther(MAX_SIDE_BET),
      settleTimeoutSeconds: SETTLE_TIMEOUT,
      refundTimeoutSeconds: REFUND_TIMEOUT,
    },
    wiring: "in progress",
  };
  const save = async (wiring: string) => {
    await fs.writeFile(DEPLOYMENT_FILE, JSON.stringify({ ...record, wiring }, null, 2) + "\n", "utf8");
  };
  await save("in progress");

  // ── 2. Platform registration ─────────────────────────────────────────────
  step("Registering as RandomProvider consumer (1 range per round)");
  const consumerArgs: [Addr, boolean, bigint] = [game.address, true, CONSUMER_RANGE_LIMIT];
  await randomProvider.simulate.setConsumerStatus(consumerArgs).catch((e: unknown) => {
    throw new Error(
      `setConsumerStatus reverted in simulation against the live RandomProvider at ${RANDOM}. ` +
        `BlackjackGame IS deployed at ${game.address} — do not redeploy. Original error: ${e}`,
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
        `BlackjackGame IS deployed at ${game.address} — do not redeploy. Original error: ${e}`,
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

  // ── 3. Table config ──────────────────────────────────────────────────────
  step("setTableConfig");
  await wait(
    await game.write.setTableConfig([
      {
        enabled: true,
        minBet: MIN_BET,
        maxBet: MAX_BET,
        maxSideBet: MAX_SIDE_BET,
        settleTimeout: SETTLE_TIMEOUT,
        refundTimeout: REFUND_TIMEOUT,
      },
    ]),
  );
  ok(`Table enabled: ${formatEther(MIN_BET)} – ${formatEther(MAX_BET)} EVA, side ≤ ${formatEther(MAX_SIDE_BET)} EVA`);

  // ── 4. Funding ───────────────────────────────────────────────────────────
  if (BANKROLL !== "0") {
    step(`Bankrolling with ${BANKROLL} EVA`);
    await wait(await token.write.transfer([game.address, parseEther(BANKROLL)]));
    ok("Bankrolled");
  }

  await save("complete");
  ok(`Deployment record: ${DEPLOYMENT_FILE.pathname}`);

  banner("DONE");
  console.log("BlackjackGame:", game.address);
  console.log("Deploy block: ", deployBlock.toString());
  console.log("\nNext:");
  console.log("  - add \"blackjack\" to the operatorsServer deployment JSON / index.json");
  console.log("  - NEXT_PUBLIC_BLACKJACK_ADDRESS in the shell, VITE_BLACKJACK_GAME in the blackjackClient secrets");
  console.log("  - BLACKJACK_GAME_ADDRESS (+ core addresses) in the blackjack backend .env; leave VRF_* empty");
  if (BANKROLL === "0") console.log("  - fund the bankroll: transfer EVA to the game address (startRound reverts without it)");
  console.log("  - the operator wallet needs ETH for gas");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
