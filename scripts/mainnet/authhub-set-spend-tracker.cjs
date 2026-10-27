/* Owner op: register (or unregister) a game as an AuthHub spend tracker so its relayed plays count against
 * the player's session spend cap. Dry-run by default.
 *   node scripts/mainnet/authhub-set-spend-tracker.cjs <gameAddress> [--off] [--execute]
 * Signs with MAINNET_DEPLOYER_PRIVATE_KEY (AuthHub owner).
 */
require("dotenv").config();
const fs = require("node:fs");
const { createPublicClient, createWalletClient, http, formatEther, getAddress } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { arbitrum } = require("viem/chains");

const argv = process.argv.slice(2);
const execute = argv.includes("--execute");
const status = !argv.includes("--off");
const game = getAddress(argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a)) ?? (() => { throw new Error("usage: <gameAddress> [--off] [--execute]"); })());
const HUB = { address: "0x86543287d870f30dd21320Dd10451Bf33E64f775", abi: JSON.parse(fs.readFileSync("artifacts/contracts/auth/AuthHub.sol/AuthHub.json", "utf8")).abi };

(async () => {
  const pk = (process.env.MAINNET_DEPLOYER_PRIVATE_KEY ?? "").trim();
  if (!pk) throw new Error("MAINNET_DEPLOYER_PRIVATE_KEY missing");
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk);
  const transport = http(process.env.MAINNET_ARBITRUM_RPC_URL);
  const pub = createPublicClient({ chain: arbitrum, transport });
  const wallet = createWalletClient({ chain: arbitrum, transport, account });
  const owner = await pub.readContract({ ...HUB, functionName: "owner" });
  if (owner.toLowerCase() !== account.address.toLowerCase()) throw new Error(`signer is not the AuthHub owner (${owner})`);
  const code = await pub.getBytecode({ address: game });
  if (!code || code === "0x") throw new Error(`${game} has no code on Arbitrum One`);
  const current = await pub.readContract({ ...HUB, functionName: "spendTrackers", args: [game] });
  console.log(`${execute ? "EXECUTE" : "DRY RUN"} · signer ${account.address} · ETH ${formatEther(await pub.getBalance({ address: account.address }))}\nAuthHub.spendTrackers(${game}): ${current} → ${status}`);
  if (current === status) { console.log("already in the requested state, nothing to do"); return; }
  if (!execute) { console.log("dry run only. Re-run with --execute to send."); return; }
  const hash = await wallet.writeContract({ ...HUB, functionName: "setSpendTracker", args: [game, status] });
  const rc = await pub.waitForTransactionReceipt({ hash });
  console.log(`setSpendTracker → ${rc.status} ${hash} · now ${await pub.readContract({ ...HUB, functionName: "spendTrackers", args: [game] })}`);
})().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });
