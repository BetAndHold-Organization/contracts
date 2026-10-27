/**
 * Incremental testnet deploy — HorseRaceBook ("bet on a horse") on Arbitrum Sepolia.
 *
 *   npx hardhat run scripts/testnet/deploy-horseracebook.ts --network arbitrumSepolia
 *
 * Reads the existing platform deployment (deployments/arbitrumSepolia.json),
 * deploys ONLY HorseRaceBook against the already-deployed core (token,
 * PaymentHandler, RandomProvider, AuthHub) and runs the full registration
 * checklist from GAME_AUTHOR_GUIDE §7:
 *
 *   1. deploy HorseRaceBook
 *   2. paymentHandler.registerGame(game, game, feeRecipient, 150, 150, 0)  — 3% total
 *   3. randomProvider.setConsumerStatus(game, true, 1)
 *   4. authHub.setSpendTracker(game, true)
 *   5. authHub.setOperator(horseOperator) + game ya tiene gameOperator del constructor
 *   6. setBetLimits(min, max, maxBetsPerRace) (default 0.1 / 1 EVA / 48), setLanes(6) y
 *      setLaneOdds (cuotas por caballo calibradas por scripts/calibrateBook.ts del backend)
 *      + engineConfigHash v5 del Book en el constructor
 *   7. bankroll EVA + auto-fund operator ETH si hace falta
 *
 * RandomProvider ya es consumer de la subscription VRF (paso por-provider, no
 * por-juego), así que no se toca la subscription.
 *
 * Env opcionales (además de los de loadTestnetEnv):
 *   HORSE_OPERATOR            — wallet operadora del backend (default: deployer)
 *   HORSE_CONFIG_ADMIN        — wallet que puede tocar la config (cuotas, límites, Revelación…) sin ser owner (default: ninguna)
 *   HORSE_ENGINE_CONFIG_HASH  — hash de engineConfig (default: engine v4)
 *   HORSE_BOOK_MIN_BET / HORSE_BOOK_MAX_BET — límites de apuesta en EVA (default: 0.1 / 1)
 *   HORSE_BOOK_MAX_BETS       — apuestas máximas por carrera (default: 48)
 *   HORSE_BANKROLL_EVA        — bankroll en EVA (default: 200)
 *
 * Actualiza deployments/arbitrumSepolia.json (key contracts.horseRaceBook) y,
 * si existe, refresca el JSON vendored del operatorsServer.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";
import { formatEther, nonceManager, parseEther } from "viem";

import { loadDeployment, saveDeployment, type Deployment } from "./lib.js";

type Addr = `0x${string}`;

// Fees del juego en el PaymentHandler — target de la plataforma: 3% total.
const HOUSE_BPS = 150;    // 1.5%
const REFERRAL_BPS = 150; // 1.5%
const JACKPOT_BPS = 0;    // 0%


// Hash del engineConfig v3 del backend (horseBackend): casa "90 % del pico",
// calibrada por Monte Carlo el 2026-07-03. Se deriva del código con
// engineConfigHash(ENGINE_CONFIG_V1) — ver backend/src/engine/engineConfig.ts.
// Un hash distinto hace que el verificador provably-fair del front rechace
// todas las carreras.
// Hash del engineConfig v5 del Book (horseBackend ENGINE_CONFIG_BOOK: 6 caballos
// con velocidades distintas). Las cuotas de abajo salen de 1M de carreras
// simuladas sobre ESA config (scripts/calibrateBook.ts, 2026-10-26): cambiar la
// config exige recalibrar y volver a setear las cuotas.
const DEFAULT_ENGINE_CONFIG_HASH =
  "0x518a35337769864c5c286ccc7e63351c3231be36da773a42125f646533b26f76" as const;
const BOOK_LANES = 6;
/** 1e4 / p_i sobre la apuesta neta: ×2.40 / ×4.94 / ×7.20 / ×9.00 / ×10.91 / ×14.40 sobre la bruta. */
const LANE_ODDS_BPS = [24705, 50904, 74179, 92833, 112497, 148460];

const DEFAULT_BANKROLL_EVA = "200";
const OPERATOR_MIN_ETH = parseEther("0.05");
const OPERATOR_TOPUP_ETH = parseEther("0.1");

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

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const networkName = conn.networkName;
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  if (networkName !== "arbitrumSepolia") {
    throw new Error(
      `This script targets arbitrumSepolia; got "${networkName}". ` +
        `Run with: npx hardhat run scripts/testnet/deploy-horserace.ts --network arbitrumSepolia`,
    );
  }

  const deployment = await loadDeployment(networkName);
  const core = deployment.contracts;

  const [deployerWallet] = await viem.getWalletClients();
  const deployer = deployerWallet.account.address as Addr;
  // Nonce-stable submission (mismo fix que deploy.ts — Infura puede laggear el nonce).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (deployerWallet.account as any).nonceManager = nonceManager;

  const waitTx = async (hash: `0x${string}`) => {
    await publicClient.waitForTransactionReceipt({ hash });
  };

  const horseOperator = ((process.env.HORSE_OPERATOR ?? "").trim() || deployer) as Addr;
  const engineConfigHash = ((process.env.HORSE_ENGINE_CONFIG_HASH ?? "").trim() ||
    DEFAULT_ENGINE_CONFIG_HASH) as `0x${string}`;
  const bankrollEva = parseEther(
    (process.env.HORSE_BANKROLL_EVA ?? "").trim() || DEFAULT_BANKROLL_EVA,
  );
  const minBet = parseEther((process.env.HORSE_BOOK_MIN_BET ?? "").trim() || "0.1");
  const maxBet = parseEther((process.env.HORSE_BOOK_MAX_BET ?? "").trim() || "1");
  const maxBets = Number((process.env.HORSE_BOOK_MAX_BETS ?? "").trim() || "48");
  if (minBet === 0n || maxBet < minBet || !Number.isInteger(maxBets) || maxBets < 1 || maxBets > 100) {
    throw new Error("HORSE_BOOK_MIN_BET / HORSE_BOOK_MAX_BET / HORSE_BOOK_MAX_BETS fuera de rango");
  }

  banner("HORSE RACE BOOK — Incremental deploy (Arbitrum Sepolia)");
  console.log("Network:           ", networkName, `(chainId ${chainId})`);
  console.log("Deployer:          ", deployer);
  console.log("Horse operator:    ", horseOperator);
  console.log("Engine config hash:", engineConfigHash);
  console.log("Bet limits (EVA):  ", `${formatEther(minBet)} – ${formatEther(maxBet)} × ${maxBets} apuestas/carrera`);
  console.log("EVA token:         ", core.evaToken);
  console.log("PaymentHandler:    ", core.paymentHandler);
  console.log("RandomProvider:    ", core.randomProvider);
  console.log("AuthHub:           ", core.authHub);
  console.log("Fee recipient:     ", deployment.wallets.feeRecipient);
  console.log(
    "Fees:              ",
    `${HOUSE_BPS / 100}% house + ${REFERRAL_BPS / 100}% referral + ${JACKPOT_BPS / 100}% jackpot`,
  );

  // ── 1. Deploy ────────────────────────────────────────────────────────────
  banner("1. Deploy HorseRaceBook");
  step("Deploying HorseRaceBook");
  const game = await viem.deployContract("HorseRaceBook", [
    core.evaToken,
    core.paymentHandler,
    core.randomProvider,
    core.authHub,
    horseOperator,
    engineConfigHash,
  ]);
  ok(`HorseRaceBook: ${game.address}`);

  // ── 2. Registro en la plataforma ────────────────────────────────────────
  banner("2. Platform registration");

  const handler = await viem.getContractAt("PaymentHandler", core.paymentHandler);
  step(`registerGame(game, game, feeRecipient, ${HOUSE_BPS}, ${REFERRAL_BPS}, ${JACKPOT_BPS})`);
  await waitTx(
    await handler.write.registerGame([
      game.address,
      game.address,
      deployment.wallets.feeRecipient,
      HOUSE_BPS,
      REFERRAL_BPS,
      JACKPOT_BPS,
    ]),
  );
  ok("Registered on PaymentHandler (3% total fees)");

  const provider = await viem.getContractAt("RandomProvider", core.randomProvider);
  step("randomProvider.setConsumerStatus(game, true, 1)");
  await waitTx(await provider.write.setConsumerStatus([game.address, true, 1n]));
  ok("Registered as RandomProvider consumer (1 range)");

  const authHub = await viem.getContractAt("AuthHub", core.authHub);
  step("authHub.setSpendTracker(game, true)");
  await waitTx(await authHub.write.setSpendTracker([game.address, true]));
  ok("Registered as AuthHub spend tracker");

  step(`authHub.setOperator(${horseOperator}, true)`);
  const alreadyOperator = (await authHub.read.isOperator([horseOperator])) as boolean;
  if (alreadyOperator) {
    ok("Horse operator already on the AuthHub allowlist");
  } else {
    await waitTx(await authHub.write.setOperator([horseOperator, true]));
    ok("Horse operator added to the AuthHub allowlist");
  }

  // ── 3. Config del juego ──────────────────────────────────────────────────
  banner("3. Game config");
  step(`setBetLimits(${formatEther(minBet)} EVA, ${formatEther(maxBet)} EVA, ${maxBets})`);
  await waitTx(await game.write.setBetLimits([minBet, maxBet, maxBets]));
  ok("Límites de apuesta seteados");
  step(`setLanes(${BOOK_LANES}) + setLaneOdds(${LANE_ODDS_BPS.join(", ")})`);
  await waitTx(await game.write.setLanes([BOOK_LANES]));
  await waitTx(await game.write.setLaneOdds([LANE_ODDS_BPS]));
  ok(`${BOOK_LANES} caballos con cuotas ${LANE_ODDS_BPS.map((o) => `×${((o / 10_000) * 0.97).toFixed(2)}`).join(" / ")} (bruta, con 3 % de fees)`);
  ok(`engineConfigHash ya seteado en el constructor: ${engineConfigHash}`);
  const configAdmin = (process.env.HORSE_CONFIG_ADMIN ?? "").trim();
  if (configAdmin) {
    step(`setConfigAdmin(${configAdmin})`);
    await waitTx(await game.write.setConfigAdmin([configAdmin as Addr]));
    ok("Config admin seteado (cuotas / límites / Revelación / lanes sin el owner)");
  }
  const [revPool, revBps, revOdds] = (await game.read.getRevelacion()) as [bigint, number, number];
  ok(`Revelación: ${revBps / 100} % del pozo al pool, paga 1 de cada ${revOdds} (pool ${revPool} wei)`);

  // ── 4. Funding ───────────────────────────────────────────────────────────
  banner("4. Funding");

  const token = await viem.getContractAt("EverValueCoin", core.evaToken);
  const deployerEva = (await token.read.balanceOf([deployer])) as bigint;
  const bankroll = deployerEva >= bankrollEva ? bankrollEva : deployerEva;
  if (bankroll === 0n) {
    console.warn("  ⚠ El deployer no tiene EVA — el juego queda SIN bankroll (lockRace va a revertir)");
  } else {
    step(`Bankroll: transfiriendo ${formatEther(bankroll)} EVA al juego`);
    await waitTx(await token.write.transfer([game.address, bankroll]));
    ok(
      `Bankroll: ${formatEther(bankroll)} EVA (una apuesta de ${formatEther(maxBet)} EVA al caballo más lento ` +
        `necesita ≈ ${formatEther((maxBet * 9700n * BigInt(LANE_ODDS_BPS[LANE_ODDS_BPS.length - 1])) / (10000n * 10000n))} EVA libres; ` +
        `el contrato rechaza las apuestas que el bankroll no cubre)`,
    );
  }

  if (horseOperator.toLowerCase() !== deployer.toLowerCase()) {
    const opBal = await publicClient.getBalance({ address: horseOperator });
    if (opBal < OPERATOR_MIN_ETH) {
      step(`Operator ETH bajo (${formatEther(opBal)}): enviando ${formatEther(OPERATOR_TOPUP_ETH)} ETH`);
      const hash = await deployerWallet.sendTransaction({
        to: horseOperator,
        value: OPERATOR_TOPUP_ETH,
      });
      await waitTx(hash);
      ok("Operator fondeado");
    } else {
      ok(`Operator ETH ok (${formatEther(opBal)})`);
    }
  } else {
    ok("Operator == deployer; sin funding extra");
  }

  // ── 5. Persistencia ──────────────────────────────────────────────────────
  banner("5. Save deployment");

  const extended = {
    ...deployment,
    deployedAt: deployment.deployedAt, // se preserva el timestamp del deploy core
    contracts: { ...deployment.contracts, horseRaceBook: game.address as Addr },
  } as Deployment & { contracts: Deployment["contracts"] & { horseRaceBook: Addr } };
  const savedPath = await saveDeployment(extended);
  ok(`deployments JSON actualizado: ${savedPath}`);

  // Refrescar el vendored del operatorsServer si el meta-repo está al lado.
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const vendored = path.join(
    scriptDir,
    "../../../backends/operatorsServer/deployments/arbitrumSepolia.json",
  );
  try {
    await fs.access(vendored);
    await fs.writeFile(vendored, JSON.stringify(extended, null, 2) + "\n", "utf8");
    ok(`vendored del operatorsServer refrescado: ${vendored}`);
  } catch {
    console.warn(`  ⚠ No se encontró el vendored del operatorsServer (${vendored}) — refrescarlo a mano`);
  }

  banner("LISTO");
  console.log("HorseRaceBook:", game.address);
  console.log("\nVerificación sugerida en Arbiscan:");
  console.log(`  - GameRegistered en PaymentHandler con ${HOUSE_BPS}/${REFERRAL_BPS}/${JACKPOT_BPS} bps`);
  console.log("  - ConsumerStatusUpdated en RandomProvider");
  console.log("  - SpendTrackerSet en AuthHub");
  console.log("  - balanceOf(game) == bankroll");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
