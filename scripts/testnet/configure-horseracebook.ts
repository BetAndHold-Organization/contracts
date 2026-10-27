/**
 * Ajusta la configuración NO custodial del HorseRaceBook ya desplegado en
 * Arbitrum Sepolia (deployments/arbitrumSepolia.json → contracts.horseRaceBook)
 * sin redeployar. Firma el deployer (owner) o el configAdmin.
 *
 *   HORSE_BOOK_MIN_BET=0.1 HORSE_BOOK_MAX_BET=1 HORSE_BOOK_MAX_BETS=48 \
 *     npx hardhat run scripts/testnet/configure-horseracebook.ts --network arbitrumSepolia
 *
 * Sólo toca lo que venga por env:
 *   HORSE_BOOK_MIN_BET / HORSE_BOOK_MAX_BET / HORSE_BOOK_MAX_BETS  → setBetLimits (los tres juntos)
 *   HORSE_BOOK_REVELACION_BPS / HORSE_BOOK_REVELACION_ODDS          → setRevelacion (los dos juntos)
 */
import { network } from "hardhat";
import { formatEther, nonceManager, parseEther } from "viem";

import { loadDeployment } from "./lib.js";

type Addr = `0x${string}`;

async function main(): Promise<void> {
  const conn = await network.connect();
  const viem = conn.viem;
  if (conn.networkName !== "arbitrumSepolia") {
    throw new Error(`This script targets arbitrumSepolia; got "${conn.networkName}"`);
  }
  const publicClient = await viem.getPublicClient();
  const deployment = await loadDeployment(conn.networkName);
  const bookAddress = (deployment.contracts as Record<string, string>).horseRaceBook as Addr | undefined;
  if (!bookAddress) throw new Error("deployments/arbitrumSepolia.json has no contracts.horseRaceBook");

  const [wallet] = await viem.getWalletClients();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (wallet.account as any).nonceManager = nonceManager;
  const book = await viem.getContractAt("HorseRaceBook", bookAddress, { client: { wallet } });
  const waitTx = async (hash: `0x${string}`) => publicClient.waitForTransactionReceipt({ hash });

  console.log(`HorseRaceBook ${bookAddress} · firmante ${wallet.account.address}`);

  const minEnv = (process.env.HORSE_BOOK_MIN_BET ?? "").trim();
  const maxEnv = (process.env.HORSE_BOOK_MAX_BET ?? "").trim();
  const capEnv = (process.env.HORSE_BOOK_MAX_BETS ?? "").trim();
  if (minEnv || maxEnv || capEnv) {
    const [curMin, curMax, curCap] = (await book.read.getBetLimits()) as [bigint, bigint, number];
    const min = minEnv ? parseEther(minEnv) : curMin;
    const max = maxEnv ? parseEther(maxEnv) : curMax;
    const cap = capEnv ? Number(capEnv) : curCap;
    console.log(`setBetLimits: ${formatEther(curMin)}–${formatEther(curMax)} × ${curCap} → ${formatEther(min)}–${formatEther(max)} × ${cap}`);
    await waitTx(await book.write.setBetLimits([min, max, cap]));
  }

  const bpsEnv = (process.env.HORSE_BOOK_REVELACION_BPS ?? "").trim();
  const oddsEnv = (process.env.HORSE_BOOK_REVELACION_ODDS ?? "").trim();
  if (bpsEnv || oddsEnv) {
    const [, curBps, curOdds] = (await book.read.getRevelacion()) as [bigint, number, number];
    const bps = bpsEnv ? Number(bpsEnv) : curBps;
    const odds = oddsEnv ? Number(oddsEnv) : curOdds;
    console.log(`setRevelacion: ${curBps} bps / 1 de ${curOdds} → ${bps} bps / 1 de ${odds}`);
    await waitTx(await book.write.setRevelacion([bps, odds]));
  }

  const [min, max, cap] = (await book.read.getBetLimits()) as [bigint, bigint, number];
  const [pool, bps, odds] = (await book.read.getRevelacion()) as [bigint, number, number];
  console.log(`Ahora: apuestas ${formatEther(min)}–${formatEther(max)} EVA × ${cap}/carrera · Revelación ${bps} bps, 1 de ${odds} (pool ${formatEther(pool)} EVA)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
