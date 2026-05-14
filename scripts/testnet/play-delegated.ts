/**
 * Testnet delegated play — Arbitrum Sepolia.
 *
 *   npx hardhat run scripts/testnet/play-delegated.ts --network arbitrumSepolia
 *
 * Exercises every *For entry. For each game:
 *   - The session key (off-chain, no gas) signs an EIP-712 payload binding
 *     the action to the specific game contract.
 *   - The operator (allowlisted on AuthHub, has gas) submits the *For call.
 *   - AuthHub charges player1's spend cap with the wager amount.
 *
 * Order:
 *   1. ProgressiveJackpot.placeDirectBetFor
 *   2. Roulette.startSpinFor
 *   3. MultiLineSlots.startSpinFor
 *   4. Plinko.placeBetFor
 *   5. PaymentOnlyGameAdapter.playFor
 *   6. Mines: startGameFor → wait VRF → commitToClicksFor → oracle sig → claimFor
 *
 * Run AFTER setup.ts has authorized player1's session key on AuthHub.
 */

import { parseEther, encodePacked, keccak256, formatEther } from "viem";

import {
  loadTestnetContext, banner, step, ok, info, warn, fmtEva,
  extractVrfRequestId, waitForRequestEvent, pollRawWord, printPlayerBalance,
  simulateAndWrite,
  type TestnetContext,
} from "./play-lib.js";

type Addr = `0x${string}`;

// ── Bet sizes (kept small) ─────────────────────────────────────────────────

const BET = parseEther("1");
const PJ_BET = parseEther("1");
const PAYOUT = parseEther("2");

const ROULETTE_MULT = 200n;
const PLINKO_ROWS = 8;
const PLINKO_RISK = 0;
const PLINKO_DROPS = 1;

const MINES_COUNT = 3;
const MINES_SECRET = ("0x" + "b2".repeat(32)) as Addr;
const MINES_NONCE_SALT = ("0x" + "6a".repeat(32)) as Addr;
const MINES_CLICKS = [0];

const DEADLINE_OFFSET = 600n; // 10 min from now

// ── Helpers ────────────────────────────────────────────────────────────────

async function now(ctx: TestnetContext): Promise<bigint> {
  const block = await ctx.publicClient.getBlock();
  return block.timestamp;
}

async function fetchChainId(ctx: TestnetContext): Promise<number> {
  return ctx.publicClient.getChainId();
}

// ── Phase 1: PJ.placeDirectBetFor ──────────────────────────────────────────

async function delegatedPJ(ctx: TestnetContext) {
  banner("Phase 1 — ProgressiveJackpot.placeDirectBetFor");
  const chainId = await fetchChainId(ctx);
  const pj = await ctx.viem.getContractAt(
    "ProgressiveJackpot", ctx.deployment.contracts.progressiveJackpot,
  );
  const nonce = await pj.read.actionNonces([ctx.wallets.player1.address]);
  const deadline = (await now(ctx)) + DEADLINE_OFFSET;

  step("Session key signs PlaceDirectBet typed data");
  const signature = await ctx.walletClients.sessionKey.signTypedData({
    account: ctx.walletClients.sessionKey.account!,
    domain: {
      name: "ProgressiveJackpot", version: "1",
      chainId, verifyingContract: ctx.deployment.contracts.progressiveJackpot,
    },
    types: {
      PlaceDirectBet: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "potentialReferrer", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "PlaceDirectBet",
    message: {
      game: ctx.deployment.contracts.progressiveJackpot,
      player: ctx.wallets.player1.address,
      potentialReferrer: "0x0000000000000000000000000000000000000000",
      nonce, deadline,
    },
  });

  step("Operator submits placeDirectBetFor(...) — simulating first");
  const txHash = await simulateAndWrite(
    ctx, ctx.walletClients.operator,
    "ProgressiveJackpot", ctx.deployment.contracts.progressiveJackpot,
    "placeDirectBetFor",
    [
      ctx.wallets.player1.address,
      "0x0000000000000000000000000000000000000000",
      nonce, deadline, signature,
    ],
  );
  const { requestId, fromBlock } = await extractVrfRequestId(ctx, txHash);
  ok(`Submitted, requestId = ${requestId}`);

  const settled = await waitForRequestEvent<{ requestId: bigint; player: Addr; outcomeIndex: number; payout: bigint }>(
    pj, "DirectBetSettled", requestId, fromBlock,
    { label: "DirectBetSettled" },
  );
  info(`outcomeIndex=${settled.outcomeIndex}, payout=${fmtEva(settled.payout ?? 0n)}`);
}

// ── Phase 2: Roulette.startSpinFor ─────────────────────────────────────────

async function delegatedRoulette(ctx: TestnetContext) {
  banner("Phase 2 — SingleRandomRoulette.startSpinFor");
  const chainId = await fetchChainId(ctx);
  const roulette = await ctx.viem.getContractAt(
    "SingleRandomRoulette", ctx.deployment.contracts.roulette,
  );
  const nonce = await roulette.read.actionNonces([ctx.wallets.player1.address]);
  const deadline = (await now(ctx)) + DEADLINE_OFFSET;

  step("Session key signs StartSpin typed data");
  const signature = await ctx.walletClients.sessionKey.signTypedData({
    account: ctx.walletClients.sessionKey.account!,
    domain: {
      name: "SingleRandomRoulette", version: "1",
      chainId, verifyingContract: ctx.deployment.contracts.roulette,
    },
    types: {
      StartSpin: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "wager", type: "uint256" },
        { name: "multiplierHundredths", type: "uint256" },
        { name: "potentialReferrer", type: "address" },
        { name: "participateInJackpot", type: "bool" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "StartSpin",
    message: {
      game: ctx.deployment.contracts.roulette,
      player: ctx.wallets.player1.address,
      wager: BET, multiplierHundredths: ROULETTE_MULT,
      potentialReferrer: "0x0000000000000000000000000000000000000000",
      participateInJackpot: false,
      nonce, deadline,
    },
  });

  step("Operator submits startSpinFor(...) — simulating first");
  const txHash = await simulateAndWrite(
    ctx, ctx.walletClients.operator,
    "SingleRandomRoulette", ctx.deployment.contracts.roulette,
    "startSpinFor",
    [
      ctx.wallets.player1.address, BET, ROULETTE_MULT,
      "0x0000000000000000000000000000000000000000", false,
      nonce, deadline, signature,
    ],
  );
  const { requestId, fromBlock } = await extractVrfRequestId(ctx, txHash);
  ok(`Submitted, requestId = ${requestId}`);

  const settled = await waitForRequestEvent<{ requestId: bigint; player: Addr; outcome: number; payout: bigint; spinsConsumed: number; jackpotPayout: bigint }>(
    roulette, "SpinResolved", requestId, fromBlock,
    { label: "SpinResolved" },
  );
  const name = ["Lose", "Multiplier", "Jackpot"][settled.outcome] ?? `Outcome#${settled.outcome}`;
  info(`outcome=${name}, payout=${fmtEva(settled.payout)}`);
}

// ── Phase 3: Slots.startSpinFor ────────────────────────────────────────────

async function delegatedSlots(ctx: TestnetContext) {
  banner("Phase 3 — MultiLineSlots.startSpinFor");
  const chainId = await fetchChainId(ctx);
  const slots = await ctx.viem.getContractAt(
    "MultiLineSlots", ctx.deployment.contracts.slots,
  );
  const nonce = await slots.read.actionNonces([ctx.wallets.player1.address]);
  const deadline = (await now(ctx)) + DEADLINE_OFFSET;

  step("Session key signs StartSpin typed data");
  const signature = await ctx.walletClients.sessionKey.signTypedData({
    account: ctx.walletClients.sessionKey.account!,
    domain: {
      name: "MultiLineSlots", version: "1",
      chainId, verifyingContract: ctx.deployment.contracts.slots,
    },
    types: {
      StartSpin: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "wagerPerLine", type: "uint256" },
        { name: "paylineCount", type: "uint8" },
        { name: "potentialReferrer", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "StartSpin",
    message: {
      game: ctx.deployment.contracts.slots,
      player: ctx.wallets.player1.address,
      wagerPerLine: BET, paylineCount: 1,
      potentialReferrer: "0x0000000000000000000000000000000000000000",
      nonce, deadline,
    },
  });

  step("Operator submits startSpinFor(...) — simulating first");
  const txHash = await simulateAndWrite(
    ctx, ctx.walletClients.operator,
    "MultiLineSlots", ctx.deployment.contracts.slots,
    "startSpinFor",
    [
      ctx.wallets.player1.address, BET, 1,
      "0x0000000000000000000000000000000000000000",
      nonce, deadline, signature,
    ],
  );
  const { requestId, fromBlock } = await extractVrfRequestId(ctx, txHash);
  ok(`Submitted, requestId = ${requestId}`);

  const settled = await waitForRequestEvent<{ requestId: bigint; player: Addr; grid: number[]; winningLineCount: number; totalPayout: bigint }>(
    slots, "SpinResolved", requestId, fromBlock, { label: "SpinResolved" },
  );
  info(`winningLines=${settled.winningLineCount}, totalPayout=${fmtEva(settled.totalPayout)}, grid=[${settled.grid.join(",")}]`);
}

// ── Phase 4: Plinko.placeBetFor ────────────────────────────────────────────

async function delegatedPlinko(ctx: TestnetContext) {
  banner("Phase 4 — Plinko.placeBetFor");
  const chainId = await fetchChainId(ctx);
  const plinko = await ctx.viem.getContractAt(
    "Plinko", ctx.deployment.contracts.plinko,
  );
  const nonce = await plinko.read.actionNonces([ctx.wallets.player1.address]);
  const deadline = (await now(ctx)) + DEADLINE_OFFSET;

  step("Session key signs PlaceBet typed data");
  const signature = await ctx.walletClients.sessionKey.signTypedData({
    account: ctx.walletClients.sessionKey.account!,
    domain: {
      name: "Plinko", version: "1",
      chainId, verifyingContract: ctx.deployment.contracts.plinko,
    },
    types: {
      PlaceBet: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "betAmount", type: "uint256" },
        { name: "rows", type: "uint8" },
        { name: "risk", type: "uint8" },
        { name: "numDrops", type: "uint8" },
        { name: "potentialReferrer", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "PlaceBet",
    message: {
      game: ctx.deployment.contracts.plinko,
      player: ctx.wallets.player1.address,
      betAmount: BET, rows: PLINKO_ROWS, risk: PLINKO_RISK, numDrops: PLINKO_DROPS,
      potentialReferrer: "0x0000000000000000000000000000000000000000",
      nonce, deadline,
    },
  });

  step("Operator submits placeBetFor(...) — simulating first");
  const txHash = await simulateAndWrite(
    ctx, ctx.walletClients.operator, "Plinko", ctx.deployment.contracts.plinko,
    "placeBetFor",
    [
      ctx.wallets.player1.address, BET, PLINKO_ROWS, PLINKO_RISK, PLINKO_DROPS,
      "0x0000000000000000000000000000000000000000",
      nonce, deadline, signature,
    ],
  );
  const { requestId, fromBlock } = await extractVrfRequestId(ctx, txHash);
  ok(`Submitted, requestId = ${requestId}`);

  const settled = await waitForRequestEvent<{ requestId: bigint; player: Addr; totalPayout: bigint; slots: number[] }>(
    plinko, "BetSettled", requestId, fromBlock, { label: "BetSettled" },
  );
  info(`slots=[${settled.slots.join(",")}], totalPayout=${fmtEva(settled.totalPayout)}`);
}

// ── Phase 5: PaymentOnlyGameAdapter.playFor ───────────────────────────────

async function delegatedPaymentOnly(ctx: TestnetContext) {
  banner("Phase 5 — PaymentOnlyGameAdapter.playFor");
  const chainId = await fetchChainId(ctx);
  const game = await ctx.viem.getContractAt(
    "PaymentOnlyGameAdapter", ctx.deployment.contracts.paymentOnlyGameAdapter,
  );
  const nonce = await game.read.actionNonces([ctx.wallets.player1.address]);
  const deadline = (await now(ctx)) + DEADLINE_OFFSET;
  const gameId = ("0x" + "07".repeat(32)) as Addr;

  step("Session key signs Play typed data");
  const signature = await ctx.walletClients.sessionKey.signTypedData({
    account: ctx.walletClients.sessionKey.account!,
    domain: {
      name: "PaymentOnlyGameAdapter", version: "1",
      chainId, verifyingContract: ctx.deployment.contracts.paymentOnlyGameAdapter,
    },
    types: {
      Play: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "potentialReferrer", type: "address" },
        { name: "gameId", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Play",
    message: {
      game: ctx.deployment.contracts.paymentOnlyGameAdapter,
      player: ctx.wallets.player1.address,
      amount: BET, potentialReferrer: "0x0000000000000000000000000000000000000000",
      gameId, nonce, deadline,
    },
  });

  step("Operator submits playFor(...) — simulating first");
  const txPlay = await simulateAndWrite(
    ctx, ctx.walletClients.operator,
    "PaymentOnlyGameAdapter", ctx.deployment.contracts.paymentOnlyGameAdapter,
    "playFor",
    [
      ctx.wallets.player1.address, BET,
      "0x0000000000000000000000000000000000000000",
      gameId, nonce, deadline, signature,
    ],
  );
  await ctx.publicClient.waitForTransactionReceipt({ hash: txPlay });
  ok("Bet collected via *For");

  step(`Operator pays winner: payWinner(player1, ${fmtEva(PAYOUT)})`);
  const txPay = await simulateAndWrite(
    ctx, ctx.walletClients.operator,
    "PaymentOnlyGameAdapter", ctx.deployment.contracts.paymentOnlyGameAdapter,
    "payWinner",
    [ctx.wallets.player1.address, PAYOUT],
  );
  await ctx.publicClient.waitForTransactionReceipt({ hash: txPay });
  ok("Winner paid");
}

// ── Phase 6: Mines full delegated cycle ───────────────────────────────────

async function delegatedMines(ctx: TestnetContext) {
  banner("Phase 6 — Mines full delegated cycle (startGameFor → wait VRF → commitToClicksFor → claimFor)");
  const chainId = await fetchChainId(ctx);
  const mines = await ctx.viem.getContractAt(
    "MinesGameHybridV2", ctx.deployment.contracts.mines,
  );
  const player = ctx.wallets.player1.address;
  const wager = BET;
  const commit = keccak256(encodePacked(
    ["bytes32", "address", "uint8", "uint256"],
    [MINES_SECRET, player, MINES_COUNT, wager],
  ));

  // ── 6a. startGameFor ──
  let nonce = await mines.read.actionNonces([player]);
  let deadline = (await now(ctx)) + DEADLINE_OFFSET;

  step("Session key signs StartGame typed data");
  const sigStart = await ctx.walletClients.sessionKey.signTypedData({
    account: ctx.walletClients.sessionKey.account!,
    domain: {
      name: "MinesGameHybridV2", version: "1",
      chainId, verifyingContract: ctx.deployment.contracts.mines,
    },
    types: {
      StartGame: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "wager", type: "uint256" },
        { name: "minesCount", type: "uint8" },
        { name: "potentialReferrer", type: "address" },
        { name: "commit", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "StartGame",
    message: {
      game: ctx.deployment.contracts.mines, player, wager,
      minesCount: MINES_COUNT,
      potentialReferrer: "0x0000000000000000000000000000000000000000",
      commit, nonce, deadline,
    },
  });

  step("Operator submits startGameFor(...) — simulating first");
  const txStart = await simulateAndWrite(
    ctx, ctx.walletClients.operator,
    "MinesGameHybridV2", ctx.deployment.contracts.mines,
    "startGameFor",
    [
      player, wager, MINES_COUNT,
      "0x0000000000000000000000000000000000000000",
      commit, nonce, deadline, sigStart,
    ],
  );
  const { requestId } = await extractVrfRequestId(ctx, txStart);
  ok(`Game started, requestId = ${requestId}`);

  // ── 6b. Wait for VRF (pull model) ──
  step("Polling RandomProvider.getRawWord(requestId) for VRF");
  await pollRawWord(ctx, requestId);
  ok("VRF fulfilled");

  // ── 6c. commitToClicksFor ──
  nonce = await mines.read.actionNonces([player]);
  deadline = (await now(ctx)) + DEADLINE_OFFSET;
  const clickCommit = keccak256(encodePacked(
    ["uint8[]", "bytes32", "address"],
    [MINES_CLICKS, MINES_NONCE_SALT, player],
  ));

  step("Session key signs CommitClicks typed data");
  const sigCommit = await ctx.walletClients.sessionKey.signTypedData({
    account: ctx.walletClients.sessionKey.account!,
    domain: {
      name: "MinesGameHybridV2", version: "1",
      chainId, verifyingContract: ctx.deployment.contracts.mines,
    },
    types: {
      CommitClicks: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "requestId", type: "uint256" },
        { name: "clickCommit", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "CommitClicks",
    message: {
      game: ctx.deployment.contracts.mines, player,
      requestId, clickCommit, nonce, deadline,
    },
  });

  step("Operator submits commitToClicksFor(...) — simulating first");
  const txCommit = await simulateAndWrite(
    ctx, ctx.walletClients.operator,
    "MinesGameHybridV2", ctx.deployment.contracts.mines,
    "commitToClicksFor",
    [player, requestId, clickCommit, nonce, deadline, sigCommit],
  );
  await ctx.publicClient.waitForTransactionReceipt({ hash: txCommit });
  ok("Click commitment recorded");

  // ── 6d. Oracle attestation ──
  step("Oracle signs (requestId, secret, clicks) attestation");
  const innerHash = keccak256(encodePacked(
    ["uint256", "bytes32", "uint8[]"],
    [requestId, MINES_SECRET, MINES_CLICKS],
  ));
  const oracleSig = await ctx.walletClients.oracleSigner.signMessage({
    account: ctx.walletClients.oracleSigner.account!,
    message: { raw: innerHash },
  });
  ok("Oracle sig built");

  // ── 6e. claimFor ──
  nonce = await mines.read.actionNonces([player]);
  deadline = (await now(ctx)) + DEADLINE_OFFSET;
  const clicksHash = keccak256(encodePacked(["uint8[]"], [MINES_CLICKS]));

  step("Session key signs Claim typed data");
  const sigClaim = await ctx.walletClients.sessionKey.signTypedData({
    account: ctx.walletClients.sessionKey.account!,
    domain: {
      name: "MinesGameHybridV2", version: "1",
      chainId, verifyingContract: ctx.deployment.contracts.mines,
    },
    types: {
      Claim: [
        { name: "game", type: "address" },
        { name: "player", type: "address" },
        { name: "requestId", type: "uint256" },
        { name: "secret", type: "bytes32" },
        { name: "clicksHash", type: "bytes32" },
        { name: "nonceCommit", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Claim",
    message: {
      game: ctx.deployment.contracts.mines, player,
      requestId, secret: MINES_SECRET, clicksHash,
      nonceCommit: MINES_NONCE_SALT, nonce, deadline,
    },
  });

  step("Operator submits claimFor(...) — simulating first");
  const txClaim = await simulateAndWrite(
    ctx, ctx.walletClients.operator,
    "MinesGameHybridV2", ctx.deployment.contracts.mines,
    "claimFor",
    [
      player, requestId, MINES_SECRET, MINES_CLICKS,
      MINES_NONCE_SALT, oracleSig, nonce, deadline, sigClaim,
    ],
  );
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txClaim });
  ok("claimFor confirmed");

  // Read outcome
  const events = await mines.getEvents.GameClaimed({}, {
    fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
  });
  const evt = events.find((e) => e.args.requestId === requestId);
  if (evt) {
    info(`hitMine=${evt.args.hitMine}, safeClicks=${evt.args.safeClicks}, payout=${fmtEva(evt.args.payout ?? 0n)}`);
  } else {
    warn("GameClaimed not found in receipt logs");
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const ctx = await loadTestnetContext();
  const authHub = await ctx.viem.getContractAt("AuthHub", ctx.deployment.contracts.authHub);

  banner("TESTNET DELEGATED PLAY — Arbitrum Sepolia");
  info(`Player1:    ${ctx.wallets.player1.address}`);
  info(`Operator:   ${ctx.wallets.operator.address}`);
  info(`SessionKey: ${ctx.wallets.sessionKey.address}`);
  const sessionKey = await authHub.read.sessionKeyOf([ctx.wallets.player1.address]);
  const remaining = await authHub.read.remainingSpend([ctx.wallets.player1.address]);
  info(`AuthHub.sessionKeyOf(player1):    ${sessionKey}`);
  info(`AuthHub.remainingSpend(player1):  ${formatEther(remaining)} EVA`);

  if (sessionKey.toLowerCase() !== ctx.wallets.sessionKey.address.toLowerCase()) {
    throw new Error(
      `Session key not authorized on AuthHub. Run setup.ts first.`,
    );
  }

  console.log("\nStarting balances:");
  await printPlayerBalance(ctx, "player1");
  await printPlayerBalance(ctx, "operator");

  await delegatedPJ(ctx);
  await delegatedRoulette(ctx);
  await delegatedSlots(ctx);
  await delegatedPlinko(ctx);
  await delegatedPaymentOnly(ctx);
  await delegatedMines(ctx);

  banner("FINAL STATE");
  await printPlayerBalance(ctx, "player1");
  await printPlayerBalance(ctx, "operator");
  const finalRemaining = await authHub.read.remainingSpend([ctx.wallets.player1.address]);
  info(`AuthHub.remainingSpend(player1) now: ${formatEther(finalRemaining)} EVA (started ${formatEther(remaining)})`);
  console.log("");
}

main().catch((e) => {
  console.error("\n✖ Play-delegated failed:", e);
  process.exit(1);
});
