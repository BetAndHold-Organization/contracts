import { network } from "hardhat";
import { formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

const CRASH    = "0x9c8b6b866013fd51d52a0d3245c64e1af4d34984" as Addr;
const TOKEN    = "0x45D9831d8751B2325f3DBf48db748723726e1C8c" as Addr;
const HANDLER  = "0xabe66fc056dd0e116b90201e487ea102fd7df1ba" as Addr;

const ERC20_ABI = [{
  type: "function", name: "balanceOf", stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

const CRASH_ABI = [
  { type: "function", name: "lockedExposure", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "operatorBond", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "currentRoundId", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "nextBetId", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function", name: "config", stateMutability: "view", inputs: [],
    outputs: [{
      name: "", type: "tuple",
      components: [
        { name: "roundIntervalSeconds", type: "uint32" },
        { name: "bettingWindowSeconds", type: "uint32" },
        { name: "revealDeadlineSeconds", type: "uint32" },
        { name: "maxMultiplier", type: "uint32" },
        { name: "reservationMultiplier", type: "uint32" },
        { name: "minBetAmount", type: "uint256" },
        { name: "maxBetAmount", type: "uint256" },
        { name: "maxPayoutPerRound", type: "uint256" },
        { name: "operatorBondAmount", type: "uint256" },
        { name: "claimWindowSeconds", type: "uint32" },
        { name: "maxBetsPerRound", type: "uint8" },
      ],
    }],
  },
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
    type: "function", name: "bets", stateMutability: "view",
    inputs: [{ name: "betId", type: "uint256" }],
    outputs: [
      { name: "player", type: "address" },
      { name: "roundId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "netAmount", type: "uint256" },
      { name: "autoCashoutMultiplier", type: "uint32" },
      { name: "mode", type: "uint8" },
      { name: "claimed", type: "bool" },
      { name: "payout", type: "uint256" },
    ],
  },
  { type: "function", name: "roundExposure", stateMutability: "view", inputs: [{ name: "", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "roundClaimableRemaining", stateMutability: "view", inputs: [{ name: "", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function", name: "roundConfigs", stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "houseEdgeBps", type: "uint16" },
      { name: "maxMultiplier", type: "uint32" },
    ],
  },
] as const;

const HANDLER_ABI = [{
  type: "function", name: "getGameConfig", stateMutability: "view",
  inputs: [{ name: "game", type: "address" }],
  outputs: [
    { name: "enabled", type: "bool" },
    { name: "payoutTarget", type: "address" },
    { name: "feeRecipient", type: "address" },
    { name: "houseEdgeBps", type: "uint16" },
    { name: "referralBps", type: "uint16" },
  ],
}] as const;

const STATE_NAMES = ["None", "Created", "Betting", "Running", "Crashed", "Revealed", "Settled"];
const MODE_NAMES = ["Auto", "Manual"];

function fmtMult(bps: number): string {
  return (bps / 10000).toFixed(2) + "x";
}

async function main() {
  const conn = await network.connect();
  const pub = await conn.viem.getPublicClient();

  const read = (args: any) => pub.readContract(args);

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  CRASH GAME STATE INSPECTOR");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  Contract:", CRASH);
  console.log("");

  // ─── Balances & core state ─────────────────────────────────────────
  const [balance, locked, bond, currentRound, nextBet] = await Promise.all([
    read({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [CRASH] }),
    read({ address: CRASH, abi: CRASH_ABI, functionName: "lockedExposure" }),
    read({ address: CRASH, abi: CRASH_ABI, functionName: "operatorBond" }),
    read({ address: CRASH, abi: CRASH_ABI, functionName: "currentRoundId" }),
    read({ address: CRASH, abi: CRASH_ABI, functionName: "nextBetId" }),
  ]) as [bigint, bigint, bigint, bigint, bigint];

  const available = balance - locked - bond;

  console.log("─── Balances ───────────────────────────────────────────────");
  console.log("  EVA balance:       ", formatEther(balance), "EVA");
  console.log("  Locked exposure:   ", formatEther(locked), "EVA");
  console.log("  Operator bond:     ", formatEther(bond), "EVA");
  console.log("  Available bankroll:", formatEther(available), "EVA");
  console.log("  Current round:     ", currentRound.toString());
  console.log("  Next bet ID:       ", nextBet.toString());
  console.log("");

  // ─── Config ────────────────────────────────────────────────────────
  const [cfg, handlerCfg] = await Promise.all([
    read({ address: CRASH, abi: CRASH_ABI, functionName: "config" }),
    read({ address: HANDLER, abi: HANDLER_ABI, functionName: "getGameConfig", args: [CRASH] }),
  ]) as [any, any];

  const totalEdgeBps = Number(handlerCfg[3]) + Number(handlerCfg[4]);

  console.log("─── Config ─────────────────────────────────────────────────");
  console.log("  minBet:            ", formatEther(cfg.minBetAmount), "EVA");
  console.log("  maxBet:            ", formatEther(cfg.maxBetAmount), "EVA");
  console.log("  maxMultiplier:     ", fmtMult(Number(cfg.maxMultiplier)));
  console.log("  reservationMult:   ", fmtMult(Number(cfg.reservationMultiplier)));
  console.log("  maxPayoutPerRound: ", formatEther(cfg.maxPayoutPerRound), "EVA");
  console.log("  operatorBondReq:   ", formatEther(cfg.operatorBondAmount), "EVA");
  console.log("  houseEdge:         ", Number(handlerCfg[3]) / 100 + "%");
  console.log("  referralBps:       ", Number(handlerCfg[4]) / 100 + "%");
  console.log("  totalEdge:         ", totalEdgeBps / 100 + "%");
  console.log("  handler enabled:   ", handlerCfg[0]);
  console.log("");

  // ─── Exposure analysis ─────────────────────────────────────────────
  console.log("─── Exposure Analysis (why InsufficientBankroll?) ───────────");
  console.log("");
  console.log("  A bet fails InsufficientBankroll if EITHER:");
  console.log("    1. maxPotentialPayout > availableBankroll");
  console.log("       (available = balance - lockedExposure - operatorBond)");
  console.log("    2. lockedExposure + maxPotentialPayout > maxPayoutPerRound");
  console.log("");

  const reserveCap = Number(cfg.reservationMultiplier) < Number(cfg.maxMultiplier)
    ? Number(cfg.reservationMultiplier) : Number(cfg.maxMultiplier);

  // Show what various bet sizes would lock
  const betSizes = [0.1, 0.25, 0.5, 1.0];
  console.log("  For a MANUAL bet (reservation at " + fmtMult(reserveCap) + "):");
  for (const bet of betSizes) {
    const betWei = BigInt(Math.round(bet * 1e18));
    const wouldLock = (betWei * BigInt(reserveCap)) / 10000n;
    const fits = wouldLock <= available && locked + wouldLock <= cfg.maxPayoutPerRound;
    console.log(`    ${bet} EVA → locks ${formatEther(wouldLock)} EVA  ${fits ? "✓ OK" : "✗ WOULD FAIL"}`);
  }
  console.log("");

  console.log("  For an AUTO bet at various multipliers:");
  for (const bet of [0.1, 0.5, 1.0]) {
    for (const mult of [20000, 50000, 100000, 500000, 1000000]) {
      if (mult > Number(cfg.maxMultiplier)) continue;
      const betWei = BigInt(Math.round(bet * 1e18));
      const wouldLock = (betWei * BigInt(mult)) / 10000n;
      const fits = wouldLock <= available && locked + wouldLock <= cfg.maxPayoutPerRound;
      console.log(`    ${bet} EVA @ ${fmtMult(mult)} → locks ${formatEther(wouldLock)} EVA  ${fits ? "✓ OK" : "✗ WOULD FAIL"}`);
    }
  }
  console.log("");

  // ─── Recent rounds ─────────────────────────────────────────────────
  const roundsToShow = Math.min(Number(currentRound), 5);
  if (roundsToShow > 0) {
    console.log("─── Recent Rounds ──────────────────────────────────────────");
    for (let i = Number(currentRound); i > Number(currentRound) - roundsToShow; i--) {
      const r = await read({ address: CRASH, abi: CRASH_ABI, functionName: "rounds", args: [BigInt(i)] }) as any;
      const rExp = await read({ address: CRASH, abi: CRASH_ABI, functionName: "roundExposure", args: [BigInt(i)] }) as bigint;
      const rClaim = await read({ address: CRASH, abi: CRASH_ABI, functionName: "roundClaimableRemaining", args: [BigInt(i)] }) as bigint;
      const rc = await read({ address: CRASH, abi: CRASH_ABI, functionName: "roundConfigs", args: [BigInt(i)] }) as any;

      console.log(`\n  Round #${i}:`);
      console.log(`    State:           ${STATE_NAMES[Number(r[1])] ?? r[1]}`);
      console.log(`    Crash point:     ${r[6] > 0 ? fmtMult(Number(r[6])) : "(not set)"}`);
      console.log(`    Total bets:      ${formatEther(r[13])} EVA (gross)`);
      console.log(`    Total payouts:   ${formatEther(r[14])} EVA`);
      console.log(`    Round exposure:  ${formatEther(rExp)} EVA (unsettled)`);
      console.log(`    Claimable left:  ${formatEther(rClaim)} EVA`);
      console.log(`    VRF word:        ${r[5] > 0n ? "received" : "pending"}`);
      console.log(`    Snapshotted edge:${Number(rc[0]) / 100}%, maxMult:${fmtMult(Number(rc[1]))}`);
    }
    console.log("");
  }

  // ─── Recent bets ──────────────────────────────────────────────────
  const totalBets = Number(nextBet) - 1;
  const betsToShow = Math.min(totalBets, 10);
  if (betsToShow > 0) {
    console.log("─── Recent Bets ────────────────────────────────────────────");
    for (let i = totalBets; i > totalBets - betsToShow; i--) {
      const b = await read({ address: CRASH, abi: CRASH_ABI, functionName: "bets", args: [BigInt(i)] }) as any;
      if (b[0] === "0x0000000000000000000000000000000000000000") continue;

      const mode = Number(b[5]);
      const autoCashout = Number(b[4]);
      const betAmount = b[2] as bigint;

      let wouldLock: bigint;
      if (mode === 0 && autoCashout > 0) {
        wouldLock = (betAmount * BigInt(autoCashout)) / 10000n;
      } else {
        wouldLock = (betAmount * BigInt(reserveCap)) / 10000n;
      }

      console.log(`\n  Bet #${i}:`);
      console.log(`    Player:          ${b[0]}`);
      console.log(`    Round:           ${b[1].toString()}`);
      console.log(`    Amount:          ${formatEther(betAmount)} EVA`);
      console.log(`    Net amount:      ${formatEther(b[3])} EVA`);
      console.log(`    Mode:            ${MODE_NAMES[mode] ?? mode}`);
      console.log(`    Auto cashout:    ${autoCashout > 0 ? fmtMult(autoCashout) : "N/A (Manual)"}`);
      console.log(`    Exposure locked: ${formatEther(wouldLock)} EVA`);
      console.log(`    Claimed:         ${b[6]}`);
      console.log(`    Payout:          ${formatEther(b[7])} EVA`);
    }
    console.log("");
  }

  // ─── Summary diagnosis ─────────────────────────────────────────────
  console.log("─── DIAGNOSIS ──────────────────────────────────────────────");
  console.log("");
  if (available <= 0n) {
    console.log("  ⚠ AVAILABLE BANKROLL IS ZERO OR NEGATIVE!");
    console.log("    balance:", formatEther(balance));
    console.log("    locked: ", formatEther(locked));
    console.log("    bond:   ", formatEther(bond));
    console.log("    → No bet of any size can succeed.");
  } else {
    const maxManualBetBeforeLimit = (available * 10000n) / BigInt(reserveCap);
    const maxManualBetBeforeRoundCap = ((cfg.maxPayoutPerRound - locked) * 10000n) / BigInt(reserveCap);
    const effectiveMax = maxManualBetBeforeLimit < maxManualBetBeforeRoundCap ? maxManualBetBeforeLimit : maxManualBetBeforeRoundCap;

    console.log("  Available bankroll:", formatEther(available), "EVA");
    console.log("  Max MANUAL bet that would pass (at " + fmtMult(reserveCap) + " reservation):");
    console.log("    Limited by bankroll:", formatEther(maxManualBetBeforeLimit), "EVA");
    console.log("    Limited by round cap:", formatEther(maxManualBetBeforeRoundCap), "EVA");
    console.log("    Effective max bet:   ", formatEther(effectiveMax), "EVA");

    if (effectiveMax < cfg.minBetAmount) {
      console.log("\n  ⚠ EFFECTIVE MAX < MIN BET! No bets can succeed.");
      console.log("    → Fund more bankroll or settle/expire pending exposure.");
    }
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
