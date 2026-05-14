import { network } from "hardhat";
import { formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

const PLINKO = "0xe06bf80bba6df203eae104968ade29b50077ee02" as Addr;
const TOKEN  = "0x45D9831d8751B2325f3DBf48db748723726e1C8c" as Addr;

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const plinko = await viem.getContractAt("Plinko", PLINKO);

  const ERC20_ABI = [{
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  }] as const;

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  PLINKO — EMERGENCY WITHDRAW TEST");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("Plinko:   ", PLINKO);
  console.log("Deployer: ", deployer.account.address);
  console.log("");

  // ─── State BEFORE ─────────────────────────────────────────────────────
  const plinkoBalBefore = await publicClient.readContract({
    address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [PLINKO],
  });
  const deployerBalBefore = await publicClient.readContract({
    address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [deployer.account.address],
  });
  const lockedBefore = await plinko.read.lockedExposure();
  const liqBefore = await plinko.read.availableLiquidity();
  const pendingBefore = await plinko.read.totalPendingBets();

  console.log("─── BEFORE ───");
  console.log("  Plinko EVA balance:  ", formatEther(plinkoBalBefore));
  console.log("  lockedExposure:      ", formatEther(lockedBefore));
  console.log("  availableLiquidity:  ", formatEther(liqBefore));
  console.log("  totalPendingBets:    ", pendingBefore.toString());
  console.log("  Deployer EVA balance:", formatEther(deployerBalBefore));
  console.log("");

  if (plinkoBalBefore === 0n) {
    console.log("  Plinko has 0 EVA — nothing to withdraw.");
    console.log("  To test: send some EVA to Plinko first, then re-run this script.");
    return;
  }

  if (pendingBefore > 0n) {
    console.warn("  ⚠ There are", pendingBefore.toString(), "pending bets. Withdrawing may leave them unsettleable.");
  }

  // ─── Execute emergencyWithdraw (amount=0 → full balance) ──────────────
  console.log("  Calling emergencyWithdraw(deployer, 0) → full balance...");
  const tx = await plinko.write.emergencyWithdraw(
    [deployer.account.address, 0n],
    { account: deployer.account },
  );
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  TX:", tx);
  console.log("  Status:", receipt.status);
  console.log("");

  // ─── State AFTER ──────────────────────────────────────────────────────
  const plinkoBalAfter = await publicClient.readContract({
    address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [PLINKO],
  });
  const deployerBalAfter = await publicClient.readContract({
    address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [deployer.account.address],
  });
  const lockedAfter = await plinko.read.lockedExposure();
  const liqAfter = await plinko.read.availableLiquidity();

  console.log("─── AFTER ───");
  console.log("  Plinko EVA balance:  ", formatEther(plinkoBalAfter));
  console.log("  lockedExposure:      ", formatEther(lockedAfter));
  console.log("  availableLiquidity:  ", formatEther(liqAfter));
  console.log("  Deployer EVA balance:", formatEther(deployerBalAfter));
  console.log("");

  console.log("─── DELTA ───");
  console.log("  Plinko:  ", formatEther(plinkoBalAfter - plinkoBalBefore), "EVA");
  console.log("  Deployer:", formatEther(deployerBalAfter - deployerBalBefore), "EVA");
  console.log("");

  if (plinkoBalAfter === 0n && deployerBalAfter > deployerBalBefore) {
    console.log("  ✓ Emergency withdraw successful — all funds recovered");
  } else {
    console.warn("  ⚠ Check results above");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
