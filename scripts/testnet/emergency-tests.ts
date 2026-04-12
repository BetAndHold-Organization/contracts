import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther, formatEther, parseAbiItem } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

const DEPLOYMENT_PATH = new URL("./deployments/arb-sepolia-v5.json", import.meta.url);

// ═══════════════════════════════════════════════════════════════════════════
// ABIs
// ═══════════════════════════════════════════════════════════════════════════

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;

const HANDLER_ABI = [
  { type: "function", name: "selfExclude", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "selfExcluded", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "setBlacklistEnabled", stateMutability: "nonpayable", inputs: [{ name: "enabled", type: "bool" }], outputs: [] },
  { type: "function", name: "setBlacklist", stateMutability: "nonpayable", inputs: [{ name: "addrs", type: "address[]" }, { name: "value", type: "bool" }], outputs: [] },
  { type: "function", name: "blacklistEnabled", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "blacklist", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "event", name: "SelfExcluded", inputs: [{ name: "account", type: "address", indexed: true }] },
] as const;

const ROULETTE_ABI = [
  { type: "function", name: "startSpin", stateMutability: "nonpayable",
    inputs: [{ name: "wager", type: "uint256" }, { name: "multiplierHundredths", type: "uint256" }, { name: "potentialReferrer", type: "address" }, { name: "participateInJackpot", type: "bool" }],
    outputs: [{ name: "requestId", type: "uint256" }] },
  { type: "function", name: "emergencyWithdraw", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "availableLiquidity", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
] as const;

const JACKPOT_ABI = [
  { type: "function", name: "emergencyWithdraw", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "tierPotBalance", stateMutability: "view",
    inputs: [{ name: "", type: "uint8" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "consolationPotBalance", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "adminAddFunds", stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "placeDirectBet", stateMutability: "nonpayable",
    inputs: [{ name: "potentialReferrer", type: "address" }], outputs: [{ name: "requestId", type: "uint256" }] },
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const ZERO = "0x0000000000000000000000000000000000000000" as Addr;
const WAGER = parseEther("0.5");

function passed(name: string, detail: string) { console.log(`  ✓ ${name}`); console.log(`    → ${detail}`); }
function failed(name: string, detail: string) { console.log(`  ✗ ${name}`); console.log(`    → ${detail}`); }

async function expectRevert(fn: () => Promise<any>, containsMsg?: string): Promise<{ reverted: boolean; message: string }> {
  try {
    await fn();
    return { reverted: false, message: "" };
  } catch (err: any) {
    const msg = err?.shortMessage || err?.message || String(err);
    if (containsMsg && !msg.includes(containsMsg)) {
      return { reverted: true, message: `Reverted but wrong reason: ${msg.slice(0, 150)}` };
    }
    return { reverted: true, message: msg.slice(0, 150) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const raw = await fs.readFile(DEPLOYMENT_PATH, "utf-8");
  const deploy = JSON.parse(raw);

  const conn = await network.connect();
  const viem = conn.viem;
  const [wallet] = await viem.getWalletClients();
  const pub = await viem.getPublicClient();
  const owner = wallet.account.address;

  const tokenAddr = deploy.token as Addr;
  const rouletteAddr = deploy.roulette as Addr;
  const jackpotAddr = deploy.jackpot as Addr;
  const handlerAddr = deploy.handler as Addr;

  console.log("==================================================================");
  console.log("  EMERGENCY & ACCESS CONTROL TESTS");
  console.log("==================================================================");
  console.log("Owner:    ", owner);
  console.log("Roulette: ", rouletteAddr);
  console.log("Jackpot:  ", jackpotAddr);
  console.log("Handler:  ", handlerAddr);
  console.log("");

  let totalTests = 0;
  let passedCount = 0;

  function track(pass: boolean) { totalTests++; if (pass) passedCount++; }

  // ═════════════════════════════════════════════════════════════════════════
  // TEST 1: ROULETTE EMERGENCY WITHDRAW
  // ═════════════════════════════════════════════════════════════════════════

  console.log("━━━ Test 1: Roulette Emergency Withdraw ━━━\n");

  const rouletteBal = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [rouletteAddr] });
  const ownerBalBefore = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] });
  const liquidity = await pub.readContract({ address: rouletteAddr, abi: ROULETTE_ABI, functionName: "availableLiquidity" });
  console.log(`  Roulette balance: ${formatEther(rouletteBal)} TRT`);
  console.log(`  Available liquidity: ${formatEther(liquidity)} TRT`);

  // 1a: Partial withdraw
  const partialAmt = parseEther("10");
  if (rouletteBal >= partialAmt) {
    const tx = await wallet.writeContract({ address: rouletteAddr, abi: ROULETTE_ABI, functionName: "emergencyWithdraw", args: [owner, partialAmt] });
    await pub.waitForTransactionReceipt({ hash: tx });

    const rouletteBalAfter = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [rouletteAddr] });
    const ownerBalAfter = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] });
    const withdrew = ownerBalAfter - ownerBalBefore;
    const p = withdrew === partialAmt;
    track(p);
    p ? passed("Partial withdraw (10 TRT)", `Owner received ${formatEther(withdrew)} TRT, roulette now ${formatEther(rouletteBalAfter)} TRT`)
      : failed("Partial withdraw", `Expected ${formatEther(partialAmt)}, got ${formatEther(withdrew)}`);
  }

  // 1b: Full withdraw (amount=0)
  const rouletteBalNow = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [rouletteAddr] });
  const ownerBal2 = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] });

  const tx1 = await wallet.writeContract({ address: rouletteAddr, abi: ROULETTE_ABI, functionName: "emergencyWithdraw", args: [owner, 0n] });
  await pub.waitForTransactionReceipt({ hash: tx1 });

  const rouletteBalFinal = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [rouletteAddr] });
  const ownerBal3 = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] });
  const fullWithdrew = ownerBal3 - ownerBal2;

  const p1b = rouletteBalFinal === 0n && fullWithdrew === rouletteBalNow;
  track(p1b);
  p1b ? passed("Full withdraw (amount=0)", `Drained ${formatEther(fullWithdrew)} TRT, roulette now 0`)
      : failed("Full withdraw", `Roulette: ${formatEther(rouletteBalFinal)}, withdrew: ${formatEther(fullWithdrew)}`);

  // 1c: Spin should fail after drain
  const res1c = await expectRevert(async () => {
    await wallet.writeContract({ address: rouletteAddr, abi: ROULETTE_ABI, functionName: "startSpin", args: [WAGER, 200n, ZERO, true] });
  });
  track(res1c.reverted);
  res1c.reverted
    ? passed("Spin fails after drain", res1c.message)
    : failed("Spin fails after drain", "Spin should have reverted but didn't");

  // 1d: Refund roulette for remaining tests
  console.log("\n  Refunding roulette with 500 TRT for remaining tests...");
  const refundAmt = parseEther("500");
  let tx = await wallet.writeContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "transfer", args: [rouletteAddr, refundAmt] });
  await pub.waitForTransactionReceipt({ hash: tx });
  const rouletteRefunded = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [rouletteAddr] });
  console.log(`  Roulette balance restored: ${formatEther(rouletteRefunded)} TRT\n`);

  // ═════════════════════════════════════════════════════════════════════════
  // TEST 2: JACKPOT EMERGENCY WITHDRAW
  // ═════════════════════════════════════════════════════════════════════════

  console.log("━━━ Test 2: Jackpot Emergency Withdraw ━━━\n");

  const jpBal = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [jackpotAddr] });
  console.log(`  Jackpot balance: ${formatEther(jpBal)} TRT`);

  // Show tier pots before
  console.log("  Tier pots before:");
  for (let t = 0; t < 9; t++) {
    const pot = await pub.readContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "tierPotBalance", args: [t] });
    if (pot > 0n) console.log(`    T${t}: ${formatEther(pot)} TRT`);
  }
  const consolPot = await pub.readContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "consolationPotBalance" });
  console.log(`    Consolation: ${formatEther(consolPot)} TRT`);

  // 2a: Full withdraw
  const ownerBal4 = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] });

  tx = await wallet.writeContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "emergencyWithdraw", args: [owner, 0n] });
  await pub.waitForTransactionReceipt({ hash: tx });

  const jpBalAfter = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [jackpotAddr] });
  const ownerBal5 = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] });

  const p2a = jpBalAfter === 0n;
  track(p2a);
  p2a ? passed("Jackpot full withdraw", `Drained ${formatEther(ownerBal5 - ownerBal4)} TRT, jackpot now 0`)
      : failed("Jackpot full withdraw", `Jackpot still has ${formatEther(jpBalAfter)}`);

  // 2b: Verify tier pots are reset
  let allZero = true;
  for (let t = 0; t < 9; t++) {
    const pot = await pub.readContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "tierPotBalance", args: [t] });
    if (pot !== 0n) allZero = false;
  }
  const consolAfter = await pub.readContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "consolationPotBalance" });
  if (consolAfter !== 0n) allZero = false;

  track(allZero);
  allZero ? passed("Tier & consolation pots reset to 0", "All 9 tier pots + consolation pot = 0")
          : failed("Pots not reset", "Some pots still have balance");

  // 2c: Direct bet should fail after drain
  const res2c = await expectRevert(async () => {
    await wallet.writeContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "placeDirectBet", args: [ZERO] });
  });
  track(res2c.reverted);
  res2c.reverted
    ? passed("Direct bet fails after drain", res2c.message)
    : failed("Direct bet fails after drain", "Should have reverted");

  // 2d: Refund jackpot
  console.log("\n  Refunding jackpot with 100 TRT...");
  tx = await wallet.writeContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "approve", args: [jackpotAddr, parseEther("100")] });
  await pub.waitForTransactionReceipt({ hash: tx });
  tx = await wallet.writeContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "adminAddFunds", args: [parseEther("100")] });
  await pub.waitForTransactionReceipt({ hash: tx });
  const jpRefunded = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf", args: [jackpotAddr] });
  console.log(`  Jackpot balance restored: ${formatEther(jpRefunded)} TRT\n`);

  // ═════════════════════════════════════════════════════════════════════════
  // TEST 3: SELF-EXCLUSION
  // ═════════════════════════════════════════════════════════════════════════

  console.log("━━━ Test 3: Self-Exclusion ━━━\n");

  // 3a: Verify not excluded initially
  const excludedBefore = await pub.readContract({ address: handlerAddr, abi: HANDLER_ABI, functionName: "selfExcluded", args: [owner] });
  const p3a = excludedBefore === false;
  track(p3a);
  p3a ? passed("Not self-excluded initially", `selfExcluded(owner) = false`)
      : failed("Initial state wrong", `selfExcluded(owner) = ${excludedBefore}`);

  // 3b: Place a spin before exclusion (should succeed)
  const res3b = await expectRevert(async () => {
    const spinTx = await wallet.writeContract({ address: rouletteAddr, abi: ROULETTE_ABI, functionName: "startSpin", args: [WAGER, 200n, ZERO, true] });
    await pub.waitForTransactionReceipt({ hash: spinTx });
  });
  const p3b = !res3b.reverted;
  track(p3b);
  p3b ? passed("Spin succeeds before exclusion", "startSpin went through")
      : failed("Spin before exclusion", `Unexpected revert: ${res3b.message}`);

  // 3c: Call selfExclude
  tx = await wallet.writeContract({ address: handlerAddr, abi: HANDLER_ABI, functionName: "selfExclude" });
  const selfExReceipt = await pub.waitForTransactionReceipt({ hash: tx });

  const excludedAfter = await pub.readContract({ address: handlerAddr, abi: HANDLER_ABI, functionName: "selfExcluded", args: [owner] });
  const p3c = excludedAfter === true;
  track(p3c);
  p3c ? passed("selfExclude() sets flag", `selfExcluded(owner) = true, tx: ${tx}`)
      : failed("selfExclude failed", `selfExcluded(owner) = ${excludedAfter}`);

  // 3d: Check SelfExcluded event
  const selfExLogs = await pub.getLogs({
    address: handlerAddr,
    event: parseAbiItem("event SelfExcluded(address indexed account)"),
    fromBlock: selfExReceipt.blockNumber,
    toBlock: selfExReceipt.blockNumber,
  });
  const p3d = selfExLogs.length > 0;
  track(p3d);
  p3d ? passed("SelfExcluded event emitted", `${selfExLogs.length} event(s)`)
      : failed("No SelfExcluded event", "Event not found");

  // 3e: Spin should fail after self-exclusion
  const res3e = await expectRevert(async () => {
    await wallet.writeContract({ address: rouletteAddr, abi: ROULETTE_ABI, functionName: "startSpin", args: [WAGER, 200n, ZERO, true] });
  }, "Self-excluded");
  track(res3e.reverted);
  res3e.reverted
    ? passed("Spin rejected after self-exclusion", res3e.message)
    : failed("Spin after exclusion", "Should have reverted with Self-excluded");

  // 3f: Direct jackpot bet should also fail
  const res3f = await expectRevert(async () => {
    await wallet.writeContract({ address: jackpotAddr, abi: JACKPOT_ABI, functionName: "placeDirectBet", args: [ZERO] });
  }, "Self-excluded");
  track(res3f.reverted);
  res3f.reverted
    ? passed("Direct bet rejected after self-exclusion", res3f.message)
    : failed("Direct bet after exclusion", "Should have reverted with Self-excluded");

  // 3g: Calling selfExclude again should revert
  const res3g = await expectRevert(async () => {
    await wallet.writeContract({ address: handlerAddr, abi: HANDLER_ABI, functionName: "selfExclude" });
  }, "Already excluded");
  track(res3g.reverted);
  res3g.reverted
    ? passed("Double selfExclude reverts", res3g.message)
    : failed("Double selfExclude", "Should have reverted with Already excluded");

  // ═════════════════════════════════════════════════════════════════════════
  // TEST 4: OWNER BLACKLIST
  // ═════════════════════════════════════════════════════════════════════════

  console.log("\n━━━ Test 4: Owner Blacklist ━━━\n");
  console.log("  (Skipped — deployer is already self-excluded, cannot test blacklist independently");
  console.log("   Blacklist logic is checked after self-exclusion in _checkAccess)\n");

  // ═════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═════════════════════════════════════════════════════════════════════════

  console.log("==================================================================");
  console.log(`  RESULTS: ${passedCount}/${totalTests} tests passed`);
  console.log("==================================================================");

  if (passedCount === totalTests) {
    console.log("\n  All tests passed!\n");
  } else {
    console.log(`\n  ${totalTests - passedCount} test(s) failed.\n`);
  }

  console.log("NOTE: The deployer wallet is now self-excluded.");
  console.log("      Roulette/jackpot bets from this address will be permanently blocked.");
  console.log("      Emergency withdraw still works (owner functions are unaffected).");
  console.log("      To run spin tests again, redeploy to get a fresh PaymentHandler.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
