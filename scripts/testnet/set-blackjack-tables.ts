/**
 * Re-shape the Sepolia blackjack room without redeploying: number of tables
 * (the on-demand cap: the backend only shows / fills the ones in use) and seats
 * per table. Keeps limits and timeouts as they are on-chain.
 *
 *   BLACKJACK_TABLES=5 BLACKJACK_SEATS=5 npx hardhat run scripts/testnet/set-blackjack-tables.ts --network arbitrumSepolia
 *
 * Restart the blackjack backend afterwards (it builds one table per on-chain table at start).
 */
import { network } from "hardhat";
import { formatEther } from "viem";
import { loadDeployment } from "./lib.js";

async function main() {
  const conn = await network.connect();
  if (conn.networkName !== "arbitrumSepolia") throw new Error(`This script targets arbitrumSepolia; got "${conn.networkName}".`);
  const publicClient = await conn.viem.getPublicClient();
  const deployment = await loadDeployment(conn.networkName);
  const address = (deployment.contracts as Record<string, string>).blackjack as `0x${string}`;
  if (!address) throw new Error("no blackjack in the deployment file");

  const lib = (deployment.contracts as Record<string, string>).blackjackTableLib as `0x${string}`;
  const game = await conn.viem.getContractAt("BlackjackTableGame", address, { libraries: { BlackjackTableLib: lib } } as never);
  const [enabled, , , minBet, maxBet, maxSideBet, settleTimeout, refundTimeout] = (await game.read.tableConfig()) as readonly [
    boolean, number, number, bigint, bigint, bigint, number, number,
  ];
  const tables = Number(process.env.BLACKJACK_TABLES ?? "5");
  const seats = Number(process.env.BLACKJACK_SEATS ?? "5");
  const hash = await game.write.setTableConfig([{ enabled, tables, seats, minBet, maxBet, maxSideBet, settleTimeout, refundTimeout }]);
  await publicClient.waitForTransactionReceipt({ hash });
  const perTable = ((maxBet * 55n) / 10n + maxSideBet * 26n) * BigInt(seats);
  console.log(`✓ ${address}: ${tables} tables × ${seats} seats (tx ${hash})`);
  console.log(`  max exposure: ${formatEther(perTable)} EVA per full table, ${formatEther(perTable * BigInt(tables))} EVA with every table full`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
