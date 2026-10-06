/* Horse Race contract migration helper (owner = deployer). Dry-run by default; nothing is sent without --execute.
 *   node scripts/mainnet/horse-migrate.cjs status
 *   node scripts/mainnet/horse-migrate.cjs pause            [--execute]   pause the OLD game (no new races; settles still work)
 *   node scripts/mainnet/horse-migrate.cjs withdraw         [--execute]   emergencyWithdraw(all EVA → deployer); requires paused + lockedExposure 0 + no open race
 *   node scripts/mainnet/horse-migrate.cjs fund <eva>       [--execute]   transfer EVA from the deployer to the NEW game
 *   node scripts/mainnet/horse-migrate.cjs disable-old-rng  [--execute]   RandomProvider.setConsumerStatus(old, false, 0)
 * Addresses: --old 0x… (default: current prod) --new 0x… (required for fund)
 */
require("dotenv").config();
const { createPublicClient, createWalletClient, http, parseAbi, formatEther, parseEther, getAddress } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { arbitrum } = require("viem/chains");
const fs = require("node:fs");

const argv = process.argv.slice(2);
const cmd = argv[0];
const execute = argv.includes("--execute");
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OLD = getAddress(opt("--old", "0x5F098F63914C1cbc1e350496669cB4Da5ACa4bF4"));
const NEW = opt("--new") ? getAddress(opt("--new")) : null;
const EVA = "0x45D9831d8751B2325f3DBf48db748723726e1C8c";
const RP = "0x6AA57111D6f5970565DC355F87Aa75e1609BE3D4";
const gameAbi = JSON.parse(fs.readFileSync("artifacts/contracts/games/horserace/HorseRaceGame.sol/HorseRaceGame.json", "utf8")).abi;
const rpAbi = parseAbi(["function allowedConsumers(address) view returns (bool)", "function setConsumerStatus(address consumer, bool allowed, uint32 numWords)"]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);

async function main() {
  const pk = process.env.MAINNET_DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("MAINNET_DEPLOYER_PRIVATE_KEY missing");
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
  const transport = http(process.env.MAINNET_ARBITRUM_RPC_URL);
  const pub = createPublicClient({ chain: arbitrum, transport });
  const wallet = createWalletClient({ account, chain: arbitrum, transport });
  const read = (addr, fn, args = []) => pub.readContract({ address: addr, abi: gameAbi, functionName: fn, args });
  const send = async (label, req) => {
    if (!execute) { console.log(`  DRY RUN · would send: ${label}`); return; }
    const hash = await wallet.writeContract(req);
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(`  ${rc.status} ${label} · ${hash}`);
    if (rc.status !== "success") throw new Error("reverted");
  };
  const status = async (addr, tag) => {
    const [paused, locked, liq, next, owner, bal] = await Promise.all([read(addr, "paused"), read(addr, "lockedExposure"), read(addr, "availableLiquidity"), read(addr, "nextRaceId"), read(addr, "owner"), pub.readContract({ address: EVA, abi: erc20, functionName: "balanceOf", args: [addr] })]);
    const rng = await pub.readContract({ address: RP, abi: rpAbi, functionName: "allowedConsumers", args: [addr] });
    console.log(`${tag} ${addr}\n  paused=${paused} lockedExposure=${formatEther(locked)} availableLiquidity=${formatEther(liq)} EVA=${formatEther(bal)} races=${Number(next) - 1} owner=${owner} rngConsumer=${rng}`);
    return { paused, locked, bal, owner };
  };
  console.log(`${execute ? "EXECUTE" : "DRY RUN"} · signer ${account.address} · ETH ${formatEther(await pub.getBalance({ address: account.address }))} · EVA ${formatEther(await pub.readContract({ address: EVA, abi: erc20, functionName: "balanceOf", args: [account.address] }))}\n`);

  if (cmd === "status") { await status(OLD, "OLD"); if (NEW) await status(NEW, "NEW"); return; }

  if (cmd === "pause") {
    const s = await status(OLD, "OLD");
    if (s.owner.toLowerCase() !== account.address.toLowerCase()) throw new Error("signer is not the owner");
    if (s.paused) { console.log("  already paused"); return; }
    await send("pause()", { address: OLD, abi: gameAbi, functionName: "pause" });
    return;
  }

  if (cmd === "withdraw") {
    const s = await status(OLD, "OLD");
    if (s.owner.toLowerCase() !== account.address.toLowerCase()) throw new Error("signer is not the owner");
    if (!s.paused) throw new Error("game must be paused first (run: pause --execute)");
    if (s.locked !== 0n) throw new Error(`lockedExposure is ${formatEther(s.locked)} EVA: a race is still in flight, wait for it to settle/refund`);
    // Make sure no race is still Created/Locked (state 1 or 2) among the most recent ones.
    const next = Number(await read(OLD, "nextRaceId"));
    for (let id = Math.max(1, next - 40); id < next; id++) {
      const race = await read(OLD, "getRace", [BigInt(id)]);
      const st = Number(race.state ?? race[0]);
      if (st === 1 || st === 2) throw new Error(`race ${id} is still open (state ${st})`);
    }
    console.log(`  will withdraw ${formatEther(s.bal)} EVA → ${account.address}`);
    await send(`emergencyWithdraw(${account.address}, all)`, { address: OLD, abi: gameAbi, functionName: "emergencyWithdraw", args: [account.address, 0n] });
    return;
  }

  if (cmd === "fund") {
    if (!NEW) throw new Error("--new 0x… required");
    const amount = parseEther(argv[1]);
    const mine = await pub.readContract({ address: EVA, abi: erc20, functionName: "balanceOf", args: [account.address] });
    if (mine < amount) throw new Error(`deployer holds ${formatEther(mine)} EVA, less than ${argv[1]}`);
    await status(NEW, "NEW");
    await send(`transfer ${argv[1]} EVA → NEW`, { address: EVA, abi: erc20, functionName: "transfer", args: [NEW, amount] });
    if (execute) console.log(`  NEW EVA now ${formatEther(await pub.readContract({ address: EVA, abi: erc20, functionName: "balanceOf", args: [NEW] }))}`);
    return;
  }

  if (cmd === "disable-old-rng") {
    const s = await status(OLD, "OLD");
    if (!s.paused) throw new Error("pause the old game first");
    await send("RandomProvider.setConsumerStatus(old, false, 0)", { address: RP, abi: rpAbi, functionName: "setConsumerStatus", args: [OLD, false, 0] });
    return;
  }
  throw new Error("unknown command; see header");
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
