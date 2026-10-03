/* Top up the gas treasuries from the deployer wallet (plain ETH transfers on Arbitrum One). Dry-run by default.
 *   node scripts/mainnet/fund-treasuries.cjs [--operators 0.1] [--rng 0.2] [--execute]
 * Signs with MAINNET_DEPLOYER_PRIVATE_KEY. Pass 0 to skip a target.
 */
require("dotenv").config();
const { createPublicClient, createWalletClient, http, formatEther, parseEther } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { arbitrum } = require("viem/chains");

const argv = process.argv.slice(2);
const execute = argv.includes("--execute");
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const TARGETS = [
  { name: "operatorsServer treasury (funds relay operators 1-4 + crash operator)", address: "0x36dE09F61E2Cc143D8Cfe4FC7759A3998afe4cFC", eth: opt("--operators", "0.1") },
  { name: "rngService treasury (funds fulfillers)", address: "0xE10Cf7f81e13De85f490a5A7e7c75DEd97bb7f7d", eth: opt("--rng", "0.2") },
];

async function main() {
  const pk = process.env.MAINNET_DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("MAINNET_DEPLOYER_PRIVATE_KEY missing in .env");
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
  const transport = http(process.env.MAINNET_ARBITRUM_RPC_URL);
  const pub = createPublicClient({ chain: arbitrum, transport });
  const wallet = createWalletClient({ account, chain: arbitrum, transport });

  const bal = await pub.getBalance({ address: account.address });
  const total = TARGETS.reduce((s, t) => s + parseEther(t.eth), 0n);
  console.log(`${execute ? "EXECUTE" : "DRY RUN"} · from ${account.address} · balance ${formatEther(bal)} ETH · total to send ${formatEther(total)} ETH`);
  if (bal < total + parseEther("0.005")) throw new Error("insufficient ETH in the deployer for these transfers plus gas");

  for (const t of TARGETS) {
    const amount = parseEther(t.eth);
    const before = await pub.getBalance({ address: t.address });
    console.log(`\n${t.name}\n  ${t.address}\n  now ${formatEther(before)} ETH → +${t.eth} ETH`);
    if (amount === 0n) { console.log("  skipped (0)"); continue; }
    if (!execute) continue;
    const hash = await wallet.sendTransaction({ to: t.address, value: amount });
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(`  ${rc.status} ${hash} · after ${formatEther(await pub.getBalance({ address: t.address }))} ETH`);
  }
  if (!execute) console.log("\nnothing sent. Re-run with --execute to send.");
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
