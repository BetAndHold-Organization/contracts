/**
 * Incremental testnet deploy — HorseRaceGame on Arbitrum Sepolia.
 *
 *   npx hardhat run scripts/testnet/deploy-horserace.ts --network arbitrumSepolia
 *
 * Reads the existing platform deployment (deployments/arbitrumSepolia.json),
 * deploys ONLY HorseRaceGame against the already-deployed core (token,
 * PaymentHandler, RandomProvider, AuthHub) and runs the full registration
 * checklist from GAME_AUTHOR_GUIDE §7:
 *
 *   1. deploy HorseRaceGame
 *   2. paymentHandler.registerGame(game, game, feeRecipient, 150, 150, 0)  — 3% total
 *   3. randomProvider.setConsumerStatus(game, true, 1)
 *   4. authHub.setSpendTracker(game, true)
 *   5. authHub.setOperator(horseOperator) + game ya tiene gameOperator del constructor
 *   6. setBetTier × HORSE_BET_TIERS (default 0.1 y 0.2 EVA)  +  engineConfigHash v3 en el constructor
 *   7. bankroll EVA + auto-fund operator ETH si hace falta
 *
 * RandomProvider ya es consumer de la subscription VRF (paso por-provider, no
 * por-juego), así que no se toca la subscription.
 *
 * Env opcionales (además de los de loadTestnetEnv):
 *   HORSE_OPERATOR            — wallet operadora del backend (default: deployer)
 *   HORSE_ENGINE_CONFIG_HASH  — hash de engineConfig (default: engine v4)
 *   HORSE_BET_TIERS           — tiers de sala en EVA, separados por coma (default: "0.1,0.2")
 *   HORSE_BANKROLL_EVA        — bankroll en EVA (default: 200)
 *
 * Actualiza deployments/arbitrumSepolia.json (key contracts.horseRaceGame) y,
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

// Tiers de sala (configurables on-chain después con setBetTier). Arrancan BAJOS
// a propósito — salas de hasta 0.2 EVA para probar con poca plata; el mínimo de
// la plataforma es 0.1 EVA. Override: HORSE_BET_TIERS="0.1,0.2,0.5".
const DEFAULT_BET_TIERS = "0.1,0.2";

function parseTiers(raw: string): bigint[] {
  const tiers = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => {
      if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`HORSE_BET_TIERS: "${t}" no es un monto en EVA`);
      return parseEther(t);
    });
  if (tiers.length === 0) throw new Error("HORSE_BET_TIERS está vacío");
  if (tiers.some((t) => t === 0n)) throw new Error("HORSE_BET_TIERS: un tier no puede ser 0");
  return tiers;
}

// Hash del engineConfig v3 del backend (horseBackend): casa "90 % del pico",
// calibrada por Monte Carlo el 2026-07-03. Se deriva del código con
// engineConfigHash(ENGINE_CONFIG_V1) — ver backend/src/engine/engineConfig.ts.
// Un hash distinto hace que el verificador provably-fair del front rechace
// todas las carreras.
const DEFAULT_ENGINE_CONFIG_HASH =
  "0x8043770ebc7ab1e5aace82d064c4d20ad15dbf05d2b01a8e9738997cd04805b7" as const;

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
  const BET_TIERS = parseTiers((process.env.HORSE_BET_TIERS ?? "").trim() || DEFAULT_BET_TIERS);

  banner("HORSE RACE — Incremental deploy (Arbitrum Sepolia)");
  console.log("Network:           ", networkName, `(chainId ${chainId})`);
  console.log("Deployer:          ", deployer);
  console.log("Horse operator:    ", horseOperator);
  console.log("Engine config hash:", engineConfigHash);
  console.log("Bet tiers (EVA):   ", BET_TIERS.map((t) => formatEther(t)).join(" / "));
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
  banner("1. Deploy HorseRaceGame");
  step("Deploying HorseRaceGame");
  const game = await viem.deployContract("HorseRaceGame", [
    core.evaToken,
    core.paymentHandler,
    core.randomProvider,
    core.authHub,
    horseOperator,
    engineConfigHash,
  ]);
  ok(`HorseRaceGame: ${game.address}`);

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
  for (const tier of BET_TIERS) {
    step(`setBetTier(${formatEther(tier)} EVA, true)`);
    await waitTx(await game.write.setBetTier([tier, true]));
    ok(`Tier ${formatEther(tier)} EVA habilitado`);
  }
  ok(`engineConfigHash ya seteado en el constructor: ${engineConfigHash}`);

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
    const topTier = BET_TIERS.reduce((a, b) => (a > b ? a : b));
    ok(
      `Bankroll: ${formatEther(bankroll)} EVA (exposure máx/carrera con el tier más alto ` +
        `≈ ${formatEther((topTier * 3n * 9700n) / 10000n)} EVA)`,
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
    contracts: { ...deployment.contracts, horseRaceGame: game.address as Addr },
  } as Deployment & { contracts: Deployment["contracts"] & { horseRaceGame: Addr } };
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
  console.log("HorseRaceGame:", game.address);
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
