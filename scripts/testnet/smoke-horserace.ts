/**
 * Smoke test del camino crítico de HorseRaceGame en Arbitrum Sepolia.
 *
 *   npx hardhat run scripts/testnet/smoke-horserace.ts --network arbitrumSepolia
 *
 * Valida end-to-end CONTRA EL VRF REAL (no el mock de los tests de hardhat):
 *   approve → createRace → joinRace (deployer en lane 0) → lockRace (dispara VRF)
 *   → poll vrfFulfilled → settleRace(winnerLane=0) → el jugador cobra el pot.
 *
 * El deployer hace de operador Y de único jugador real; las otras 3 lanes son
 * caballos de la casa. Settlear con winnerLane=0 hace que el deployer recupere
 * su apuesta (costo neto ≈ los fees), dejando el bankroll casi intacto.
 *
 * Gasta gas + 1 request de LINK de la subscription. Idempotente por roomId
 * (usa el timestamp del bloque), así que se puede reintentar.
 */

import { network } from "hardhat";
import {
  encodePacked,
  formatEther,
  keccak256,
  nonceManager,
  parseEther,
  toHex,
  type Hex,
} from "viem";

import { loadDeployment } from "./lib.js";

type Addr = `0x${string}`;

const TIER = parseEther("1");
const POLL_INTERVAL_MS = 8_000;
const POLL_TIMEOUT_MS = 5 * 60_000; // VRF en Sepolia suele llegar < 1-2 min

function banner(s: string) {
  console.log("\n" + "═".repeat(70));
  console.log(s);
  console.log("═".repeat(70));
}
const ok = (s: string) => console.log(`  ✓ ${s}`);
const step = (s: string) => console.log(`\n→ ${s}`);

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  if (conn.networkName !== "arbitrumSepolia") {
    throw new Error(`targets arbitrumSepolia; got "${conn.networkName}"`);
  }
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const me = wallet.account.address as Addr;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (wallet.account as any).nonceManager = nonceManager;
  const waitTx = (hash: `0x${string}`) => publicClient.waitForTransactionReceipt({ hash });

  const dep = await loadDeployment(conn.networkName);
  const gameAddr = (dep.contracts as any).horseRaceGame as Addr;
  if (!gameAddr) throw new Error("horseRaceGame no está en el deployment JSON — corré deploy-horserace.ts primero");

  const game = await viem.getContractAt("HorseRaceGame", gameAddr);
  const token = await viem.getContractAt("EverValueCoin", dep.contracts.evaToken);

  banner("HORSE RACE — smoke test (Arbitrum Sepolia, VRF real)");
  console.log("Game:     ", gameAddr);
  console.log("Player/op:", me);

  // Server seed → commit (igual que en producción el backend commitea el hash).
  const serverSeed = keccak256(toHex(`smoke-${Date.now()}`)) as Hex;
  const commit = keccak256(encodePacked(["bytes32"], [serverSeed]));
  const roomId = keccak256(toHex(`room-${Date.now()}`)) as Hex;

  // ── approve ──
  const allowance = (await token.read.allowance([me, gameAddr])) as bigint;
  if (allowance < TIER) {
    step(`approve(${formatEther(TIER)} EVA) al juego`);
    await waitTx(await token.write.approve([gameAddr, TIER]));
    ok("approve listo");
  } else {
    ok("allowance suficiente");
  }

  // ── createRace ──
  step("createRace(roomId, 1 EVA, commit)");
  await waitTx(await game.write.createRace([roomId, TIER, commit]));
  const raceId = (await game.read.getRaceIdByRoom([roomId])) as bigint;
  ok(`raceId = ${raceId}`);

  // ── joinRace (deployer en lane 0) ──
  step("joinRace(roomId) — deployer ocupa la lane 0");
  await waitTx(await game.write.joinRace([roomId, "0x0000000000000000000000000000000000000000"]));
  let race = (await game.read.getRace([raceId])) as any;
  ok(`playerCount = ${race.playerCount}`);

  // ── lockRace (dispara VRF) ──
  step("lockRace(roomId) → request VRF (3 caballos de la casa)");
  await waitTx(await game.write.lockRace([roomId]));
  race = (await game.read.getRace([raceId])) as any;
  ok(`state=Locked, houseTopUp=${formatEther(race.houseTopUp)} EVA, vrfRequestId=${race.vrfRequestId}`);
  ok(`exposureLocked=${formatEther(race.exposureLocked)} EVA, lockedExposure=${formatEther(await game.read.lockedExposure())}`);

  // ── poll VRF ──
  step("Esperando fulfillment del VRF…");
  const start = Date.now();
  let fulfilled = false;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    race = (await game.read.getRace([raceId])) as any;
    if (race.vrfFulfilled) {
      fulfilled = true;
      break;
    }
    process.stdout.write(`  … ${Math.round((Date.now() - start) / 1000)}s\r`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (!fulfilled) {
    throw new Error(
      `VRF no llegó en ${POLL_TIMEOUT_MS / 1000}s. Revisar que la subscription VRF tenga LINK ` +
        `y que el RandomProvider esté como consumer en vrf.chain.link.`,
    );
  }
  ok(`VRF fulfilled — randomWord = ${race.vrfRandomWord}`);

  // ── settleRace (winnerLane=0 → el deployer cobra, recupera la apuesta) ──
  const carrotHash = keccak256(toHex("smoke-carrots"));
  step("settleRace(winnerLane=0, reveal serverSeed)");
  const balBefore = (await token.read.balanceOf([me])) as bigint;
  await waitTx(await game.write.settleRace([raceId, serverSeed, 0, carrotHash]));
  const balAfter = (await token.read.balanceOf([me])) as bigint;
  race = (await game.read.getRace([raceId])) as any;
  ok(`state=Settled, winnerLane=${race.winnerLane}, prize cobrado = ${formatEther(balAfter - balBefore)} EVA`);
  ok(`lockedExposure tras settle = ${formatEther(await game.read.lockedExposure())} EVA (debe ser 0)`);

  banner("SMOKE TEST OK ✅");
  console.log("create → join → lock → VRF real → settle: el camino crítico funciona on-chain.");
}

main().catch((e) => {
  console.error("\n❌ smoke test falló:", e.shortMessage ?? e.message ?? e);
  process.exitCode = 1;
});
