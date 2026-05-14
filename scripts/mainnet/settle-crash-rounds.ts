import { network } from "hardhat";
import { formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

const CRASH = "0x9c8b6b866013fd51d52a0d3245c64e1af4d34984" as Addr;

const ABI = [
  { type: "function", name: "currentRoundId", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "lockedExposure", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "roundExposure", stateMutability: "view", inputs: [{ name: "", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function", name: "rounds", stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint256" }],
    outputs: [
      { name: "roundId", type: "uint256" },
      { name: "state", type: "uint8" },
      { name: "commitHash", type: "bytes32" },
      { name: "serverSeed", type: "bytes32" },
      { name: "vrfRequestId", type: "uint256" },
      { name: "vrfRandomWord", type: "uint256" },
      { name: "crashPoint", type: "uint32" },
      { name: "bettingOpensAt", type: "uint64" },
      { name: "bettingClosesAt", type: "uint64" },
      { name: "crashedAt", type: "uint64" },
      { name: "revealDeadline", type: "uint64" },
      { name: "merkleRoot", type: "bytes32" },
      { name: "totalBetAmount", type: "uint256" },
      { name: "totalGrossBetAmount", type: "uint256" },
      { name: "totalPayoutAmount", type: "uint256" },
    ],
  },
  {
    type: "function", name: "settleRoundExposure", stateMutability: "nonpayable",
    inputs: [{ name: "roundId", type: "uint256" }, { name: "totalClaimable", type: "uint256" }],
    outputs: [],
  },
] as const;

const STATE_NAMES = ["None", "Created", "Betting", "Running", "Crashed", "Revealed", "Settled"];

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const pub = await viem.getPublicClient();

  const read = (args: any) => pub.readContract(args);

  const currentRound = Number(await read({ address: CRASH, abi: ABI, functionName: "currentRoundId" }));
  const lockedBefore = await read({ address: CRASH, abi: ABI, functionName: "lockedExposure" }) as bigint;

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  SETTLE ALL UNSETTLED CRASH ROUNDS");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  Current round:    ", currentRound);
  console.log("  Locked exposure:  ", formatEther(lockedBefore), "EVA");
  console.log("");

  // Scan all rounds for unsettled exposure
  const unsettled: { roundId: number; exposure: bigint; state: number }[] = [];

  console.log("  Scanning rounds 1 to", currentRound, "...");
  for (let i = 1; i <= currentRound; i++) {
    const exp = await read({ address: CRASH, abi: ABI, functionName: "roundExposure", args: [BigInt(i)] }) as bigint;
    if (exp > 0n) {
      const r = await read({ address: CRASH, abi: ABI, functionName: "rounds", args: [BigInt(i)] }) as any;
      const state = Number(r[1]);
      unsettled.push({ roundId: i, exposure: exp, state });
    }
  }

  if (unsettled.length === 0) {
    console.log("\n  No unsettled rounds found. All clean.");
    return;
  }

  console.log(`\n  Found ${unsettled.length} unsettled round(s):\n`);
  for (const u of unsettled) {
    console.log(`    Round #${u.roundId}: ${formatEther(u.exposure)} EVA locked, state=${STATE_NAMES[u.state] ?? u.state}`);
  }

  // Settle revealed rounds with totalClaimable = 0
  // (safe for rounds with no merkle root / no valid claims)
  console.log("\n  Settling...\n");
  let settled = 0;
  let released = 0n;

  for (const u of unsettled) {
    // Only settle Revealed rounds (state 5) — skip active rounds
    if (u.state !== 5) {
      console.log(`    Round #${u.roundId}: SKIPPED (state=${STATE_NAMES[u.state]}, not Revealed)`);
      continue;
    }

    try {
      const tx = await deployer.writeContract({
        address: CRASH, abi: ABI,
        functionName: "settleRoundExposure",
        args: [BigInt(u.roundId), 0n],
      });
      await pub.waitForTransactionReceipt({ hash: tx });
      console.log(`    Round #${u.roundId}: settled (released ${formatEther(u.exposure)} EVA) TX: ${tx}`);
      settled++;
      released += u.exposure;
    } catch (e: any) {
      console.log(`    Round #${u.roundId}: FAILED — ${e?.shortMessage || e?.message || e}`);
    }
  }

  const lockedAfter = await read({ address: CRASH, abi: ABI, functionName: "lockedExposure" }) as bigint;

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  DONE");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  Rounds settled:   ", settled);
  console.log("  Exposure released:", formatEther(released), "EVA");
  console.log("  Locked before:    ", formatEther(lockedBefore), "EVA");
  console.log("  Locked after:     ", formatEther(lockedAfter), "EVA");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
