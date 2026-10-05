/* Top up the gas treasuries from the deployer wallet (plain ETH transfers on Arbitrum One). Dry-run by default.
 *   node scripts/mainnet/fund-treasuries.cjs [--operators 0.1] [--rng 0.2] [--horse-operator 0.05] [--horse-bankroll 10] [--execute]
 * Signs with MAINNET_DEPLOYER_PRIVATE_KEY. Pass 0 to skip a target.
 */
require("dotenv").config();
const { createPublicClient, createWalletClient, http, formatEther, parseEther, parseAbi } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { arbitrum } = require("viem/chains");

const argv = process.argv.slice(2);
const execute = argv.includes("--execute");
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const TARGETS = [
  { name: "operatorsServer treasury (funds relay operators 1-4 + crash operator)", address: "0x36dE09F61E2Cc143D8Cfe4FC7759A3998afe4cFC", eth: opt("--operators", "0.1") },
  { name: "rngService treasury (funds fulfillers)", address: "0xE10Cf7f81e13De85f490a5A7e7c75DEd97bb7f7d", eth: opt("--rng", "0.2") },
  { name: "Horse Race operator (gas for lockRace/settle)", address: "0x3ef7563Da2556291470823969D6dC26A7F18d8e3", eth: opt("--horse-operator", "0") },
];
const EVA = "0x45D9831d8751B2325f3DBf48db748723726e1C8c";
const HORSE_GAME = "0x5F098F63914C1cbc1e350496669cB4Da5ACa4bF4";
const HORSE_BANKROLL = opt("--horse-bankroll", "0"); // EVA transferred to the game contract (house lane top-ups)
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);

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
  if (HORSE_BANKROLL !== "0") {
    const amount = parseEther(HORSE_BANKROLL);
    const mine = await pub.readContract({ address: EVA, abi: erc20, functionName: "balanceOf", args: [account.address] });
    const before = await pub.readContract({ address: EVA, abi: erc20, functionName: "balanceOf", args: [HORSE_GAME] });
    console.log(`\nHorse Race bankroll (EVA → game contract)\n  ${HORSE_GAME}\n  game now ${formatEther(before)} EVA → +${HORSE_BANKROLL} EVA · deployer has ${formatEther(mine)} EVA`);
    if (mine < amount) throw new Error("deployer does not hold that much EVA");
    if (execute) {
      const hash = await wallet.writeContract({ address: EVA, abi: erc20, functionName: "transfer", args: [HORSE_GAME, amount] });
      const rc = await pub.waitForTransactionReceipt({ hash });
      console.log(`  ${rc.status} ${hash} · game after ${formatEther(await pub.readContract({ address: EVA, abi: erc20, functionName: "balanceOf", args: [HORSE_GAME] }))} EVA`);
    }
  }
  if (!execute) console.log("\nnothing sent. Re-run with --execute to send.");
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
