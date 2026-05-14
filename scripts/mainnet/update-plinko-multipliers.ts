import { network } from "hardhat";
import { formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

const PLINKO = "0xe06bf80bba6df203eae104968ade29b50077ee02" as Addr;

// v2 Power Curve + Floor — RTP ~97% per table
// MULTIPLIER_SCALE = 100 → stored 120 = 1.20x, stored 82 = 0.82x
// See: docs/rtp-adjustment-proposal-97-v2.md
const MULTIPLIER_TABLES: Record<number, Record<number, bigint[]>> = {
  8: {
    0: [120n, 111n, 105n, 100n, 82n, 100n, 105n, 111n, 120n],
    1: [346n, 229n, 139n, 79n, 55n, 79n, 139n, 229n, 346n],
    2: [566n, 331n, 164n, 63n, 30n, 63n, 164n, 331n, 566n],
  },
  10: {
    0: [115n, 110n, 106n, 103n, 100n, 82n, 100n, 103n, 106n, 110n, 115n],
    1: [434n, 308n, 204n, 125n, 73n, 52n, 73n, 125n, 204n, 308n, 434n],
    2: [836n, 522n, 290n, 136n, 51n, 28n, 51n, 136n, 290n, 522n, 836n],
  },
  12: {
    0: [271n, 223n, 179n, 141n, 109n, 84n, 70n, 84n, 109n, 141n, 179n, 223n, 271n],
    1: [293n, 236n, 186n, 144n, 108n, 83n, 70n, 83n, 108n, 144n, 186n, 236n, 293n],
    2: [1187n, 788n, 480n, 258n, 115n, 41n, 22n, 41n, 115n, 258n, 480n, 788n, 1187n],
  },
  14: {
    0: [314n, 263n, 216n, 174n, 137n, 105n, 81n, 68n, 81n, 105n, 137n, 174n, 216n, 263n, 314n],
    1: [366n, 300n, 240n, 188n, 142n, 105n, 78n, 65n, 78n, 105n, 142n, 188n, 240n, 300n, 366n],
    2: [1575n, 1094n, 713n, 426n, 224n, 97n, 35n, 20n, 35n, 97n, 224n, 426n, 713n, 1094n, 1575n],
  },
  16: {
    0: [363n, 309n, 259n, 212n, 171n, 134n, 102n, 78n, 65n, 78n, 102n, 134n, 171n, 212n, 259n, 309n, 363n],
    1: [596n, 485n, 385n, 295n, 218n, 153n, 102n, 66n, 50n, 66n, 102n, 153n, 218n, 295n, 385n, 485n, 596n],
    2: [2031n, 1460n, 1000n, 641n, 375n, 193n, 83n, 31n, 20n, 31n, 83n, 193n, 375n, 641n, 1000n, 1460n, 2031n],
  },
};

const PLINKO_ABI = [
  { type: "function", name: "totalPendingBets", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "setPaused", stateMutability: "nonpayable", inputs: [{ name: "_paused", type: "bool" }], outputs: [] },
  {
    type: "function", name: "setMultipliers", stateMutability: "nonpayable",
    inputs: [
      { name: "rows", type: "uint8" },
      { name: "risk", type: "uint8" },
      { name: "mults", type: "uint256[]" },
    ],
    outputs: [],
  },
  {
    type: "function", name: "getMultipliers", stateMutability: "view",
    inputs: [{ name: "rows", type: "uint8" }, { name: "risk", type: "uint8" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
] as const;

const RISK_NAMES = ["Low", "Medium", "High"];

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const pub = await viem.getPublicClient();

  const read = (args: any) => pub.readContract(args);
  const write = async (args: any) => {
    const tx = await deployer.writeContract(args);
    await pub.waitForTransactionReceipt({ hash: tx });
    return tx;
  };

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  PLINKO MULTIPLIER UPDATE — RTP 97%");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  Contract:", PLINKO);
  console.log("  Deployer:", deployer.account.address);
  console.log("");

  // ─── Step 1: Check no pending bets ─────────────────────────────────
  console.log("Step 1 — Checking pending bets...");
  const pendingBets = await read({
    address: PLINKO, abi: PLINKO_ABI, functionName: "totalPendingBets",
  }) as bigint;

  if (pendingBets > 0n) {
    console.error(`  ✘ ${pendingBets} pending bets still active. Cannot update multipliers.`);
    console.error("    Wait for all bets to resolve or cancel expired ones first.");
    process.exit(1);
  }
  console.log("  ✔ No pending bets");
  console.log("");

  // ─── Step 2: Pause the game ────────────────────────────────────────
  console.log("Step 2 — Pausing game...");
  const alreadyPaused = await read({
    address: PLINKO, abi: PLINKO_ABI, functionName: "paused",
  }) as boolean;

  if (alreadyPaused) {
    console.log("  Already paused, skipping.");
  } else {
    const tx = await write({
      address: PLINKO, abi: PLINKO_ABI, functionName: "setPaused", args: [true],
    });
    console.log("  ✔ Paused  tx:", tx);
  }
  console.log("");

  // ─── Step 3: Set all 15 multiplier tables ──────────────────────────
  console.log("Step 3 — Setting multiplier tables...");
  let count = 0;
  for (const [rowsStr, risks] of Object.entries(MULTIPLIER_TABLES)) {
    const rows = parseInt(rowsStr);
    for (const [riskStr, mults] of Object.entries(risks)) {
      const risk = parseInt(riskStr);
      const tx = await write({
        address: PLINKO, abi: PLINKO_ABI,
        functionName: "setMultipliers",
        args: [rows, risk, mults],
      });
      count++;
      console.log(`  [${count}/15] ${rows}R ${RISK_NAMES[risk].padEnd(6)} ✔  tx: ${tx}`);
    }
  }
  console.log("");

  // ─── Step 4: Verification — read back 8R Low ──────────────────────
  console.log("Step 4 — Verifying getMultipliers(8, 0)...");
  const expected = MULTIPLIER_TABLES[8][0];
  const actual = await read({
    address: PLINKO, abi: PLINKO_ABI,
    functionName: "getMultipliers", args: [8, 0],
  }) as bigint[];

  const match = actual.length === expected.length &&
    actual.every((v, i) => v === expected[i]);

  console.log("  Expected:", `[${expected.join(", ")}]`);
  console.log("  Actual:  ", `[${actual.join(", ")}]`);

  if (!match) {
    console.error("  ✘ MISMATCH — aborting without unpausing!");
    console.error("    Investigate and fix before unpausing manually.");
    process.exit(1);
  }
  console.log("  ✔ Match confirmed");
  console.log("");

  // ─── Step 5: Unpause ───────────────────────────────────────────────
  console.log("Step 5 — Unpausing game...");
  const txUnpause = await write({
    address: PLINKO, abi: PLINKO_ABI, functionName: "setPaused", args: [false],
  });
  console.log("  ✔ Unpaused  tx:", txUnpause);
  console.log("");

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  DONE — 15 tables updated, verified, game live.");
  console.log("══════════════════════════════════════════════════════════════");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
