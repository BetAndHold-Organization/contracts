/**
 * Ancla un engineConfigHash nuevo en el HorseRaceGame de Arbitrum Sepolia
 * (setEngineConfigHash, owner o configAdmin). Las carreras ya creadas conservan
 * el hash que snapshotearon; solo las nuevas toman el nuevo. Reiniciar el
 * backend después: elige la config del motor por el hash anclado.
 *
 *   HORSE_ENGINE_CONFIG_HASH=0x… npx hardhat run scripts/testnet/set-horserace-engine-hash.ts --network arbitrumSepolia
 *
 * Sin HORSE_ENGINE_CONFIG_HASH ancla el default del deploy (engine v6).
 */
import { network } from "hardhat";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ENGINE_CONFIG_HASH = "0xdef93d8b55b4dee70b75b26fc826428b242f389e33c90519760ac86153e4f0ec" as const;

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  if (!wallet) throw new Error("falta la clave del deployer en el .env (ARBITRUM_SEPOLIA_PRIVATE_KEY)");

  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, "../../deployments/arbitrumSepolia.json");
  const deployment = JSON.parse(await fs.readFile(file, "utf8")) as { contracts: { horseRaceGame?: `0x${string}` } };
  const game = deployment.contracts.horseRaceGame;
  if (!game) throw new Error(`deployments/arbitrumSepolia.json sin contracts.horseRaceGame`);

  const hash = ((process.env.HORSE_ENGINE_CONFIG_HASH ?? "").trim() || DEFAULT_ENGINE_CONFIG_HASH) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`HORSE_ENGINE_CONFIG_HASH inválido: ${hash}`);

  const abi = [
    { type: "function", name: "currentEngineConfigHash", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
    { type: "function", name: "setEngineConfigHash", stateMutability: "nonpayable", inputs: [{ name: "hash", type: "bytes32" }], outputs: [] },
  ] as const;
  const current = (await publicClient.readContract({ address: game, abi, functionName: "currentEngineConfigHash" })) as string;
  console.log(`HorseRaceGame ${game}`);
  console.log(`  anclado: ${current}`);
  console.log(`  nuevo:   ${hash}`);
  if (current.toLowerCase() === hash.toLowerCase()) {
    console.log("  ya estaba anclado — nada que hacer");
    return;
  }
  const tx = await wallet.writeContract({ address: game, abi, functionName: "setEngineConfigHash", args: [hash] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") throw new Error(`setEngineConfigHash revirtió: ${tx}`);
  console.log(`  ✓ setEngineConfigHash → tx ${tx} (bloque ${receipt.blockNumber})`);
  console.log("  Reiniciá el backend del horse: toma la config del motor por el hash anclado.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
