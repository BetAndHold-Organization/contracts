/**
 * Testnet direct play — Arbitrum Sepolia.
 *
 *   npx hardhat run scripts/testnet/play-direct.ts --network arbitrumSepolia
 *
 * Exercises each game's direct-bet entry as player1, with real Chainlink VRF
 * fulfilling each request. No randomness control — we report whatever outcome
 * happens. Each game takes ~30-90 seconds to settle (VRF callback latency).
 *
 * Phases:
 *   1. ProgressiveJackpot.placeDirectBet  (single VRF request)
 *   2. SingleRandomRoulette.startSpin     (single VRF request)
 *   3. MultiLineSlots.startSpin           (single VRF request)
 *   4. Plinko.placeBet                    (single VRF request)
 *   5. PaymentOnlyGameAdapter.play        (no VRF; operator pays the winner)
 *   6. Mines: startGame → wait VRF → commitToClicks → oracle signs → claim
 *
 * Skip / re-run individual phases by commenting them out in main().
 */

import { parseEther, encodePacked, keccak256, formatEther } from "viem";

import {
  loadTestnetContext, banner, step, ok, info, warn, fmtEva, sleep,
  extractVrfRequestId, waitForRequestEvent, pollRawWord, printPlayerBalance,
  type TestnetContext,
} from "./play-lib.js";

type Addr = `0x${string}`;

// ── Per-game bet sizes (small, since real EVA + real VRF cost LINK) ───────

const BET_AMOUNT = parseEther("1");      // 1 EVA bet on each game
const PJ_BET     = parseEther("1");      // PJ tier 0 fixed cost
const PAYOUT_AMOUNT = parseEther("2");   // PaymentOnlyGameAdapter "winner" payout

const ROULETTE_MULT = 200n;              // 2.00x — minimum allowed per the table
const PLINKO_ROWS   = 8;
const PLINKO_RISK   = 0;                 // RiskLevel.Low
const PLINKO_DROPS  = 1;

const MINES_COUNT       = 3;
const MINES_SECRET      = ("0x" + "a1".repeat(32)) as Addr;
const MINES_NONCE_SALT  = ("0x" + "5a".repeat(32)) as Addr;
const MINES_CLICKS      = [0]; // one click — could hit a mine or not, we don't care

// ── Phase 1: ProgressiveJackpot direct bet ─────────────────────────────────

async function playProgressiveJackpot(ctx: TestnetContext) {
  banner("Phase 1 — ProgressiveJackpot.placeDirectBet");
  const pj = await ctx.viem.getContractAt(
    "ProgressiveJackpot", ctx.deployment.contracts.progressiveJackpot,
    { client: { wallet: ctx.walletClients.player1 } },
  );
  step("Submitting placeDirectBet(potentialReferrer=0x0)");
  const txHash = await pj.write.placeDirectBet(["0x0000000000000000000000000000000000000000"]);
  const { requestId, fromBlock } = await extractVrfRequestId(ctx, txHash);
  ok(`Submitted, requestId = ${requestId}`);

  // Watch for DirectBetSettled on the PJ contract
  const pjReader = await ctx.viem.getContractAt(
    "ProgressiveJackpot", ctx.deployment.contracts.progressiveJackpot,
  );
  // DirectBetSettled(requestId, player, outcomeIndex, payout)
  const settled = await waitForRequestEvent<{ requestId: bigint; player: Addr; outcomeIndex: number; payout: bigint }>(
    pjReader, "DirectBetSettled", requestId, fromBlock,
    { label: "DirectBetSettled" },
  );
  info(`outcomeIndex=${settled.outcomeIndex}, payout=${fmtEva(settled.payout ?? 0n)}`);
}

// ── Phase 2: Roulette ──────────────────────────────────────────────────────

async function playRoulette(ctx: TestnetContext) {
  banner("Phase 2 — SingleRandomRoulette.startSpin");
  const roulette = await ctx.viem.getContractAt(
    "SingleRandomRoulette", ctx.deployment.contracts.roulette,
    { client: { wallet: ctx.walletClients.player1 } },
  );
  step(`Submitting startSpin(${fmtEva(BET_AMOUNT)}, mult=${ROULETTE_MULT}, no referrer, participateInJackpot=false)`);
  const txHash = await roulette.write.startSpin([
    BET_AMOUNT, ROULETTE_MULT, "0x0000000000000000000000000000000000000000", false,
  ]);
  const { requestId, fromBlock } = await extractVrfRequestId(ctx, txHash);
  ok(`Submitted, requestId = ${requestId}`);

  const reader = await ctx.viem.getContractAt(
    "SingleRandomRoulette", ctx.deployment.contracts.roulette,
  );
  const settled = await waitForRequestEvent<{ requestId: bigint; player: Addr; outcome: number; payout: bigint; spinsConsumed: number; jackpotPayout: bigint }>(
    reader, "SpinResolved", requestId, fromBlock,
    { label: "SpinResolved" },
  );
  const outcomeName = ["Lose", "Multiplier", "Jackpot"][settled.outcome] ?? `Outcome#${settled.outcome}`;
  info(`outcome=${outcomeName}, spinsConsumed=${settled.spinsConsumed}, payout=${fmtEva(settled.payout)}, jackpotPayout=${fmtEva(settled.jackpotPayout ?? 0n)}`);
}

// ── Phase 3: Slots ─────────────────────────────────────────────────────────

async function playSlots(ctx: TestnetContext) {
  banner("Phase 3 — MultiLineSlots.startSpin");
  const slots = await ctx.viem.getContractAt(
    "MultiLineSlots", ctx.deployment.contracts.slots,
    { client: { wallet: ctx.walletClients.player1 } },
  );
  step(`Submitting startSpin(wagerPerLine=${fmtEva(BET_AMOUNT)}, paylines=1, no referrer)`);
  const txHash = await slots.write.startSpin([
    BET_AMOUNT, 1, "0x0000000000000000000000000000000000000000",
  ]);
  const { requestId, fromBlock } = await extractVrfRequestId(ctx, txHash);
  ok(`Submitted, requestId = ${requestId}`);

  const reader = await ctx.viem.getContractAt(
    "MultiLineSlots", ctx.deployment.contracts.slots,
  );
  const settled = await waitForRequestEvent<{ requestId: bigint; player: Addr; grid: number[]; winningLineCount: number; totalPayout: bigint }>(
    reader, "SpinResolved", requestId, fromBlock,
    { label: "SpinResolved" },
  );
  info(`winningLines=${settled.winningLineCount}, totalPayout=${fmtEva(settled.totalPayout)}`);
  info(`grid=[${settled.grid.join(",")}]`);
}

// ── Phase 4: Plinko ────────────────────────────────────────────────────────

async function playPlinko(ctx: TestnetContext) {
  banner("Phase 4 — Plinko.placeBet");
  const plinko = await ctx.viem.getContractAt(
    "Plinko", ctx.deployment.contracts.plinko,
    { client: { wallet: ctx.walletClients.player1 } },
  );
  step(`Submitting placeBet(${fmtEva(BET_AMOUNT)}, rows=${PLINKO_ROWS}, risk=Low, drops=${PLINKO_DROPS})`);
  const txHash = await plinko.write.placeBet([
    BET_AMOUNT, PLINKO_ROWS, PLINKO_RISK, PLINKO_DROPS, "0x0000000000000000000000000000000000000000",
  ]);
  const { requestId, fromBlock } = await extractVrfRequestId(ctx, txHash);
  ok(`Submitted, requestId = ${requestId}`);

  const reader = await ctx.viem.getContractAt(
    "Plinko", ctx.deployment.contracts.plinko,
  );
  const settled = await waitForRequestEvent<{ requestId: bigint; player: Addr; totalPayout: bigint; numDrops: number; slots: number[]; randomWord: bigint }>(
    reader, "BetSettled", requestId, fromBlock,
    { label: "BetSettled" },
  );
  info(`slots=[${settled.slots.join(",")}], totalPayout=${fmtEva(settled.totalPayout)}`);
}

// ── Phase 5: PaymentOnlyGameAdapter ───────────────────────────────────────

async function playPaymentOnly(ctx: TestnetContext) {
  banner("Phase 5 — PaymentOnlyGameAdapter (off-chain game)");
  const game = await ctx.viem.getContractAt(
    "PaymentOnlyGameAdapter", ctx.deployment.contracts.paymentOnlyGameAdapter,
    { client: { wallet: ctx.walletClients.player1 } },
  );
  const gameId = ("0x" + "01".repeat(32)) as Addr;

  step(`player1: play(${fmtEva(BET_AMOUNT)}, no referrer, gameId=0x01..01)`);
  const txPlay = await game.write.play([BET_AMOUNT, "0x0000000000000000000000000000000000000000", gameId]);
  await ctx.publicClient.waitForTransactionReceipt({ hash: txPlay });
  ok("Bet collected on-chain");

  step(`operator: payWinner(player1, ${fmtEva(PAYOUT_AMOUNT)})`);
  const gameAsOperator = await ctx.viem.getContractAt(
    "PaymentOnlyGameAdapter", ctx.deployment.contracts.paymentOnlyGameAdapter,
    { client: { wallet: ctx.walletClients.operator } },
  );
  const txPay = await gameAsOperator.write.payWinner([ctx.wallets.player1.address, PAYOUT_AMOUNT]);
  await ctx.publicClient.waitForTransactionReceipt({ hash: txPay });
  ok("Operator paid winner");
}

// ── Phase 6: Mines (full game) ─────────────────────────────────────────────

async function playMines(ctx: TestnetContext) {
  banner("Phase 6 — Mines (start → wait VRF → commit clicks → oracle attest → claim)");
  const mines = await ctx.viem.getContractAt(
    "MinesGameHybridV2", ctx.deployment.contracts.mines,
    { client: { wallet: ctx.walletClients.player1 } },
  );

  // commit = keccak256(secret, player, minesCount, wager)
  const commit = keccak256(encodePacked(
    ["bytes32", "address", "uint8", "uint256"],
    [MINES_SECRET, ctx.wallets.player1.address, MINES_COUNT, BET_AMOUNT],
  ));

  step(`startGame(${fmtEva(BET_AMOUNT)}, minesCount=${MINES_COUNT})`);
  const txStart = await mines.write.startGame([
    BET_AMOUNT, MINES_COUNT, "0x0000000000000000000000000000000000000000", commit,
  ]);
  const { requestId, fromBlock } = await extractVrfRequestId(ctx, txStart);
  ok(`Game started, requestId = ${requestId}`);

  // Mines uses the pull model: it doesn't implement IRandomConsumer.fulfillRandomness,
  // so RandomProvider's push-callback reverts silently (caught) and `RequestFailed`
  // fires instead of `RandomWordsFulfilled`. The raw VRF word IS stored on the provider
  // before the try/catch, so we poll getRawWord(requestId) until it's non-zero.
  step("Waiting for VRF — polling RandomProvider.getRawWord(requestId)");
  const rawWord = await pollRawWord(ctx, requestId);
  ok(`VRF fulfilled, rawWord = 0x${rawWord.toString(16).slice(0, 10)}…`);

  // commitToClicks
  const clickCommit = keccak256(encodePacked(
    ["uint8[]", "bytes32", "address"],
    [MINES_CLICKS, MINES_NONCE_SALT, ctx.wallets.player1.address],
  ));
  step(`commitToClicks(requestId=${requestId}, clickCommit=…)`);
  const txCommit = await mines.write.commitToClicks([requestId, clickCommit]);
  await ctx.publicClient.waitForTransactionReceipt({ hash: txCommit });
  ok("Click commitment recorded");

  // Oracle signs the (requestId, secret, clicks) tuple
  step("Oracle signs the click-outcome attestation");
  const innerHash = keccak256(encodePacked(
    ["uint256", "bytes32", "uint8[]"],
    [requestId, MINES_SECRET, MINES_CLICKS],
  ));
  const oracleSig = await ctx.walletClients.oracleSigner.signMessage({
    account: ctx.walletClients.oracleSigner.account!,
    message: { raw: innerHash },
  });
  ok("Oracle sig built");

  // claim
  step("player1: claim(...)");
  const txClaim = await mines.write.claim([
    requestId, MINES_SECRET, MINES_CLICKS, MINES_NONCE_SALT, oracleSig,
  ]);
  const claimReceipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txClaim });
  ok("Claim tx confirmed");

  // Read the GameClaimed event for outcome details
  const reader = await ctx.viem.getContractAt(
    "MinesGameHybridV2", ctx.deployment.contracts.mines,
  );
  const claimed = await reader.getEvents.GameClaimed({}, {
    fromBlock: claimReceipt.blockNumber, toBlock: claimReceipt.blockNumber,
  });
  const evt = claimed.find((e) => e.args.requestId === requestId);
  if (evt) {
    info(`hitMine=${evt.args.hitMine}, safeClicks=${evt.args.safeClicks}, payout=${fmtEva(evt.args.payout ?? 0n)}`);
  } else {
    warn("GameClaimed event not found in claim receipt — check tx manually");
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const ctx = await loadTestnetContext();

  banner("TESTNET DIRECT PLAY — Arbitrum Sepolia");
  info(`Player1: ${ctx.wallets.player1.address}`);
  console.log("\nStarting balances:");
  for (const role of ["player1", "operator"] as const) {
    await printPlayerBalance(ctx, role);
  }

  // Run phases. Comment out any that you don't want to run.
  await playProgressiveJackpot(ctx);
  await playRoulette(ctx);
  await playSlots(ctx);
  await playPlinko(ctx);
  await playPaymentOnly(ctx);
  await playMines(ctx);

  banner("FINAL BALANCES");
  for (const role of ["player1", "operator"] as const) {
    await printPlayerBalance(ctx, role);
  }
  console.log("");
}

main().catch((e) => {
  console.error("\n✖ Play-direct failed:", e);
  process.exit(1);
});
