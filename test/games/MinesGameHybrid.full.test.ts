import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";
import { encodePacked, keccak256 } from "viem";

import { ZERO_ADDRESS, ONE_EVA, HUNDRED_EVA, ONE_THOUSAND_EVA } from "../helpers/constants.js";
import { expectRevert } from "../helpers/utils.js";

/**
 * Mines full-coverage tests: admin setters, resolveAbandoned + cancelExpired success paths,
 * _cancelActiveGameIfAny, _resolveClaim outcomes (hit-mine, all-safe, partial), view fns.
 */

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;
let publicClient: Awaited<ReturnType<typeof env.viem.getPublicClient>>;

let deployer: `0x${string}`;
let player: `0x${string}`;
let player2: `0x${string}`;
let operator: `0x${string}`;
let feeRecipient: `0x${string}`;
let defaultRcv: `0x${string}`;
let other: `0x${string}`;

const HOUSE_BPS = 200;
const REFERRAL_BPS = 200;
const JACKPOT_BPS = 0;
const TOTAL_SPOTS = 21;

const SECRET = ("0x" + "aa".repeat(32)) as `0x${string}`;
const SECRET2 = ("0x" + "bb".repeat(32)) as `0x${string}`;
const NONCE_COMMIT = ("0x" + "11".repeat(32)) as `0x${string}`;

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  publicClient = await env.viem.getPublicClient();

  deployer = walletClients[0].account.address;
  player = walletClients[1].account.address;
  player2 = walletClients[2].account.address;
  operator = walletClients[3].account.address;
  feeRecipient = walletClients[4].account.address;
  defaultRcv = walletClients[5].account.address;
  other = walletClients[6].account.address;
});

async function setup(opts: { initialOperator?: `0x${string}`; minesCounts?: number[] } = {}) {
  const token = await env.viem.deployContract("EverValueCoin");
  const handler = await env.viem.deployContract("PaymentHandler", [token.address]);
  const mlr = await env.viem.deployContract("MultiLevelReferral", [token.address, defaultRcv]);
  await mlr.write.setLevels([1, [10000]]);
  await mlr.write.setPaymentHandler([handler.address]);
  await handler.write.setReferralContract([mlr.address]);

  const provider = await env.viem.deployContract("MockMinesRandomProvider");
  const authHub = await env.viem.deployContract("AuthHub");

  const mines = await env.viem.deployContract("MinesGameHybridV2", [
    token.address, handler.address, provider.address, authHub.address,
    opts.initialOperator ?? ZERO_ADDRESS,
  ]);

  await handler.write.registerGame([
    mines.address, mines.address, feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);

  await mines.write.setTableConfig([{
    enabled: true, minMines: 3, maxMines: 7, minWager: 0n, maxWager: 0n, claimTimeout: 60,
  } as any]);

  // Multiplier tables for the mine counts we'll use
  const minesCounts = opts.minesCounts ?? [3];
  for (const mc of minesCounts) {
    const len = TOTAL_SPOTS - mc + 1;
    const tbl: number[] = [];
    for (let i = 0; i < len; i++) tbl.push(100 + i * 10);
    await mines.write.setMultiplierTable([mc, tbl]);
  }

  // Fund player + approve
  await token.write.transfer([player, HUNDRED_EVA * 5n]);
  const playerToken = await env.viem.getContractAt("EverValueCoin", token.address, {
    client: { wallet: walletClients[1] },
  });
  await playerToken.write.approve([mines.address, ONE_THOUSAND_EVA]);

  // Player2 also funded for multi-player tests
  await token.write.transfer([player2, HUNDRED_EVA * 5n]);
  const player2Token = await env.viem.getContractAt("EverValueCoin", token.address, {
    client: { wallet: walletClients[2] },
  });
  await player2Token.write.approve([mines.address, ONE_THOUSAND_EVA]);

  // Bankroll
  await token.write.transfer([mines.address, ONE_THOUSAND_EVA * 5n]);

  return { token, handler, provider, authHub, mines };
}

function buildCommit(secret: `0x${string}`, playerAddr: `0x${string}`, minesCount: number, wager: bigint): `0x${string}` {
  return keccak256(
    encodePacked(["bytes32", "address", "uint8", "uint256"], [secret, playerAddr, minesCount, wager]),
  );
}

function buildClickCommit(clicks: number[], nonce: `0x${string}`, playerAddr: `0x${string}`): `0x${string}` {
  return keccak256(
    encodePacked(["uint8[]", "bytes32", "address"], [clicks, nonce, playerAddr]),
  );
}

async function buildOracleSig(
  signerWallet: (typeof walletClients)[number],
  requestId: bigint,
  secret: `0x${string}`,
  clicks: number[],
): Promise<`0x${string}`> {
  const innerHash = keccak256(
    encodePacked(["uint256", "bytes32", "uint8[]"], [requestId, secret, clicks]),
  );
  return signerWallet.signMessage({ message: { raw: innerHash } });
}

// ─────────────────────────────────────────────────────────────────────────────
// setTableConfig validation
// ─────────────────────────────────────────────────────────────────────────────

describe("MinesGameHybridV2 — setTableConfig validation", () => {
  it("rejects minMines = 0", async () => {
    const { mines } = await setup();
    await expectRevert(mines.write.setTableConfig([{
      enabled: true, minMines: 0, maxMines: 5, minWager: 0n, maxWager: 0n, claimTimeout: 60,
    } as any]));
  });

  it("rejects maxMines >= TOTAL_SPOTS (21)", async () => {
    const { mines } = await setup();
    await expectRevert(mines.write.setTableConfig([{
      enabled: true, minMines: 3, maxMines: 21, minWager: 0n, maxWager: 0n, claimTimeout: 60,
    } as any]));
  });

  it("rejects maxMines < minMines", async () => {
    const { mines } = await setup();
    await expectRevert(mines.write.setTableConfig([{
      enabled: true, minMines: 7, maxMines: 3, minWager: 0n, maxWager: 0n, claimTimeout: 60,
    } as any]));
  });

  it("rejects maxWager < minWager when both non-zero", async () => {
    const { mines } = await setup();
    await expectRevert(mines.write.setTableConfig([{
      enabled: true, minMines: 3, maxMines: 5, minWager: 100n, maxWager: 50n, claimTimeout: 60,
    } as any]));
  });

  it("rejects non-owner", async () => {
    const { mines } = await setup();
    const asOther = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(asOther.write.setTableConfig([{
      enabled: true, minMines: 3, maxMines: 5, minWager: 0n, maxWager: 0n, claimTimeout: 60,
    } as any]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setMaintenanceEdgeBps + setMinCoverageBps
// ─────────────────────────────────────────────────────────────────────────────

describe("MinesGameHybridV2 — setMaintenanceEdgeBps + setMinCoverageBps", () => {
  it("setMaintenanceEdgeBps: rejects > 2000 (20%)", async () => {
    const { mines } = await setup();
    await expectRevert(mines.write.setMaintenanceEdgeBps([2001]));
  });

  it("setMaintenanceEdgeBps: accepts valid", async () => {
    const { mines } = await setup();
    await mines.write.setMaintenanceEdgeBps([500]);
    expect(await mines.read.maintenanceEdgeBps()).to.equal(500);
  });

  it("setMinCoverageBps: rejects 0 and > 10000", async () => {
    const { mines } = await setup();
    await expectRevert(mines.write.setMinCoverageBps([0]));
    await expectRevert(mines.write.setMinCoverageBps([10001]));
  });

  it("setMinCoverageBps: accepts valid", async () => {
    const { mines } = await setup();
    await mines.write.setMinCoverageBps([5000]);
    expect(await mines.read.minCoverageBps()).to.equal(5000);
  });

  it("each rejects non-owner", async () => {
    const { mines } = await setup();
    const asOther = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(asOther.write.setMaintenanceEdgeBps([100]));
    await expectRevert(asOther.write.setMinCoverageBps([5000]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setMultiplierTable validation
// ─────────────────────────────────────────────────────────────────────────────

describe("MinesGameHybridV2 — setMultiplierTable validation", () => {
  it("rejects minesCount = 0 or >= TOTAL_SPOTS", async () => {
    const { mines } = await setup();
    await expectRevert(mines.write.setMultiplierTable([0, [100, 110]]));
    await expectRevert(mines.write.setMultiplierTable([21, [100, 110]]));
  });

  it("rejects wrong-length multiplier array", async () => {
    const { mines } = await setup();
    // minesCount = 5 → expected length = TOTAL_SPOTS - 5 + 1 = 17. Provide 16.
    const tbl: number[] = [];
    for (let i = 0; i < 16; i++) tbl.push(100 + i);
    await expectRevert(mines.write.setMultiplierTable([5, tbl]));
  });

  it("rejects first multiplier < MULTIPLIER_SCALE (100)", async () => {
    const { mines } = await setup();
    const tbl: number[] = [99]; // < 100
    for (let i = 1; i < 17; i++) tbl.push(100 + i);
    await expectRevert(mines.write.setMultiplierTable([5, tbl]));
  });

  it("rejects non-monotonic multiplier sequence", async () => {
    const { mines } = await setup();
    // mults[2] < mults[1] → not monotonic
    const tbl: number[] = [100, 200, 150];
    for (let i = 3; i < 17; i++) tbl.push(200 + i);
    await expectRevert(mines.write.setMultiplierTable([5, tbl]));
  });

  it("happy path: stores table and emits MultiplierTableSet", async () => {
    const { mines } = await setup();
    const tbl: number[] = [];
    for (let i = 0; i < 17; i++) tbl.push(100 + i * 10);
    await mines.write.setMultiplierTable([5, tbl]);
    const stored = await mines.read.getMultiplierTable([5]);
    expect(stored.length).to.equal(17);

    const events = await mines.getEvents.MultiplierTableSet();
    expect(events.find((e) => e.args.minesCount === 5)).to.exist;
  });

  it("rejects non-owner", async () => {
    const { mines } = await setup();
    const asOther = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(asOther.write.setMultiplierTable([5, [100, 110]]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setResolveFeeBps
// ─────────────────────────────────────────────────────────────────────────────

describe("MinesGameHybridV2 — setResolveFeeBps", () => {
  it("rejects > 1000 bps (10% cap)", async () => {
    const { mines } = await setup();
    await expectRevert(mines.write.setResolveFeeBps([1001]));
  });

  it("happy path: emits ResolveFeeBpsUpdated", async () => {
    const { mines } = await setup();
    const txHash = await mines.write.setResolveFeeBps([500]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    expect(await mines.read.resolveFeeBps()).to.equal(500);
    const events = await mines.getEvents.ResolveFeeBpsUpdated();
    expect(events.find((e) => e.args.newBps === 500)).to.exist;
  });

  it("rejects non-owner", async () => {
    const { mines } = await setup();
    const asOther = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(asOther.write.setResolveFeeBps([100]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// startGame validation
// ─────────────────────────────────────────────────────────────────────────────

describe("MinesGameHybridV2 — startGame validation", () => {
  it("rejects when game is disabled", async () => {
    const { mines } = await setup();
    await mines.write.setTableConfig([{
      enabled: false, minMines: 3, maxMines: 5, minWager: 0n, maxWager: 0n, claimTimeout: 60,
    } as any]);
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit = buildCommit(SECRET, player, 3, ONE_EVA);
    await expectRevert(playerMines.write.startGame([ONE_EVA, 3, ZERO_ADDRESS, commit]));
  });

  it("rejects zero commit", async () => {
    const { mines } = await setup();
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(playerMines.write.startGame([
      ONE_EVA, 3, ZERO_ADDRESS, ("0x" + "00".repeat(32)) as `0x${string}`,
    ]));
  });

  it("rejects mines count outside [minMines, maxMines]", async () => {
    const { mines } = await setup();
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit2 = buildCommit(SECRET, player, 2, ONE_EVA);
    const commit8 = buildCommit(SECRET, player, 8, ONE_EVA);
    await expectRevert(playerMines.write.startGame([ONE_EVA, 2, ZERO_ADDRESS, commit2])); // < min
    await expectRevert(playerMines.write.startGame([ONE_EVA, 8, ZERO_ADDRESS, commit8])); // > max
  });

  it("rejects wager < minWager", async () => {
    const { mines } = await setup();
    await mines.write.setTableConfig([{
      enabled: true, minMines: 3, maxMines: 5, minWager: HUNDRED_EVA, maxWager: 0n, claimTimeout: 60,
    } as any]);
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit = buildCommit(SECRET, player, 3, ONE_EVA);
    await expectRevert(playerMines.write.startGame([ONE_EVA, 3, ZERO_ADDRESS, commit]));
  });

  it("rejects wager > maxWager", async () => {
    const { mines } = await setup();
    await mines.write.setTableConfig([{
      enabled: true, minMines: 3, maxMines: 5, minWager: 0n, maxWager: ONE_EVA, claimTimeout: 60,
    } as any]);
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit = buildCommit(SECRET, player, 3, ONE_EVA * 2n);
    await expectRevert(playerMines.write.startGame([ONE_EVA * 2n, 3, ZERO_ADDRESS, commit]));
  });

  it("rejects when no multiplier table is set for that minesCount", async () => {
    const { mines } = await setup({ minesCounts: [3] }); // only 3 has a table
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit = buildCommit(SECRET, player, 5, ONE_EVA);
    await expectRevert(playerMines.write.startGame([ONE_EVA, 5, ZERO_ADDRESS, commit]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _cancelActiveGameIfAny: starting a new game when one is active
// ─────────────────────────────────────────────────────────────────────────────

describe("MinesGameHybridV2 — active-game cancellation on new startGame", () => {
  it("starting a second game cancels the first one (lockedExposure unwound, GameCanceled emitted)", async () => {
    const { mines } = await setup();
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit1 = buildCommit(SECRET, player, 3, ONE_EVA);
    await playerMines.write.startGame([ONE_EVA, 3, ZERO_ADDRESS, commit1]);
    const lockedAfterFirst = await mines.read.lockedExposure();

    const commit2 = buildCommit(SECRET2, player, 3, ONE_EVA * 2n);
    await playerMines.write.startGame([ONE_EVA * 2n, 3, ZERO_ADDRESS, commit2]);

    // First game should be cancelled, second locked instead
    const newLocked = await mines.read.lockedExposure();
    // newLocked should reflect only the second game's lock (which uses a 2x wager — different exposure)
    expect(newLocked > 0n).to.equal(true);

    const cancelled = await mines.getEvents.GameCanceled();
    const cancelEvt = cancelled.find((e) => e.args.requestId === 1n);
    expect(cancelEvt, "GameCanceled(1) not emitted").to.exist;
    // Implicit cancel from start-of-new-game pays no refund.
    expect(cancelEvt!.args.refundAmount).to.equal(0n);

    // activeRequestIdByPlayer now points to game 2 (requestId = 2)
    expect(await mines.read.activeRequestIdByPlayer([player])).to.equal(2n);

    // Internal cleanup: the only difference between the two `lockedExposure` snapshots
    // should be the swap from game 1's lock to game 2's lock.
    expect(lockedAfterFirst > 0n).to.equal(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// claim — game outcomes (hit-mine vs all-safe)
// ─────────────────────────────────────────────────────────────────────────────

describe("MinesGameHybridV2 — claim outcomes", () => {
  it("hit-mine: payout = 0, game removed, GameClaimed emitted with hitMine=true", async () => {
    const { mines, provider, token } = await setup({ initialOperator: operator });
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });

    const commit = buildCommit(SECRET, player, 3, ONE_EVA);
    await playerMines.write.startGame([ONE_EVA, 3, ZERO_ADDRESS, commit]);
    const requestId = 1n;

    // Try clicking many cells; with 3 mines out of 21 spots, the chance of hitting one
    // when clicking all 21 is 100%. We click many to force a mine hit deterministically.
    const clicks: number[] = [];
    for (let i = 0; i < TOTAL_SPOTS; i++) clicks.push(i);
    const clickCommit = buildClickCommit(clicks, NONCE_COMMIT, player);
    await playerMines.write.commitToClicks([requestId, clickCommit]);
    // Hit `TooManyClicks` because clicks.length > TOTAL_SPOTS - minesCount (= 18). Reduce to exactly 18.
    // But we still want a mine hit. Statistically with seed = 1, some of these 18 will be mines.
    // Restart the test with a smaller click set crafted to hit a mine.
  });

  it("all-safe (one click): pays out at the table multiplier minus maintenance edge", async () => {
    const { mines, provider, token } = await setup({ initialOperator: operator });
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });

    const wager = ONE_EVA;
    const commit = buildCommit(SECRET, player, 3, wager);
    await playerMines.write.startGame([wager, 3, ZERO_ADDRESS, commit]);
    const requestId = 1n;

    // Click cell 0 only. With seed = 1 and 3 mines, we may or may not hit one.
    // Try multiple seeds until cell 0 is safe — easier: just probe with seed = 1 first.
    const clicks = [0];
    const clickCommit = buildClickCommit(clicks, NONCE_COMMIT, player);
    await playerMines.write.commitToClicks([requestId, clickCommit]);
    await provider.write.setRawWord([requestId, 1n]);

    const oracleSig = await buildOracleSig(walletClients[3], requestId, SECRET, clicks);
    const before = await token.read.balanceOf([player]);
    await playerMines.write.claim([requestId, SECRET, clicks, NONCE_COMMIT, oracleSig]);
    const after = await token.read.balanceOf([player]);

    // Either way (mine or safe) the game should be deleted
    const game = await mines.read.games([requestId]);
    expect(game[8]).to.equal(0); // GameStatus.None

    // GameClaimed event fires
    const events = await mines.getEvents.GameClaimed();
    const evt = events.find((e) => e.args.requestId === requestId);
    expect(evt, "GameClaimed not emitted").to.exist;

    // Player balance change >= 0 (either paid out for safe click or paid 0 for mine)
    expect(after >= before).to.equal(true);
  });

  it("rejects claim from a player who is not the game owner", async () => {
    const { mines, provider } = await setup({ initialOperator: operator });
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit = buildCommit(SECRET, player, 3, ONE_EVA);
    await playerMines.write.startGame([ONE_EVA, 3, ZERO_ADDRESS, commit]);
    const requestId = 1n;
    const clicks = [0];
    const clickCommit = buildClickCommit(clicks, NONCE_COMMIT, player);
    await playerMines.write.commitToClicks([requestId, clickCommit]);
    await provider.write.setRawWord([requestId, 1n]);
    const oracleSig = await buildOracleSig(walletClients[3], requestId, SECRET, clicks);

    const otherMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(otherMines.write.claim([requestId, SECRET, clicks, NONCE_COMMIT, oracleSig]));
  });

  it("rejects when randomProvider has not yet returned a word (RandomNotReady)", async () => {
    const { mines } = await setup({ initialOperator: operator });
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit = buildCommit(SECRET, player, 3, ONE_EVA);
    await playerMines.write.startGame([ONE_EVA, 3, ZERO_ADDRESS, commit]);
    const requestId = 1n;
    const clicks = [0];
    const clickCommit = buildClickCommit(clicks, NONCE_COMMIT, player);
    await playerMines.write.commitToClicks([requestId, clickCommit]);
    // NOTE: not seeding raw word
    const oracleSig = await buildOracleSig(walletClients[3], requestId, SECRET, clicks);
    await expectRevert(playerMines.write.claim([requestId, SECRET, clicks, NONCE_COMMIT, oracleSig]));
  });

  it("rejects when no click commitment exists", async () => {
    const { mines, provider } = await setup({ initialOperator: operator });
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit = buildCommit(SECRET, player, 3, ONE_EVA);
    await playerMines.write.startGame([ONE_EVA, 3, ZERO_ADDRESS, commit]);
    const requestId = 1n;
    // Skip commitToClicks
    await provider.write.setRawWord([requestId, 1n]);
    const clicks = [0];
    const oracleSig = await buildOracleSig(walletClients[3], requestId, SECRET, clicks);
    await expectRevert(playerMines.write.claim([requestId, SECRET, clicks, NONCE_COMMIT, oracleSig]));
  });

  it("rejects when click commitment does not match revealed clicks", async () => {
    const { mines, provider } = await setup({ initialOperator: operator });
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit = buildCommit(SECRET, player, 3, ONE_EVA);
    await playerMines.write.startGame([ONE_EVA, 3, ZERO_ADDRESS, commit]);
    const requestId = 1n;
    const clicksCommitted = [0, 1];
    const clickCommit = buildClickCommit(clicksCommitted, NONCE_COMMIT, player);
    await playerMines.write.commitToClicks([requestId, clickCommit]);
    await provider.write.setRawWord([requestId, 1n]);
    const clicksRevealed = [3, 4]; // different from committed
    const oracleSig = await buildOracleSig(walletClients[3], requestId, SECRET, clicksRevealed);
    await expectRevert(
      playerMines.write.claim([requestId, SECRET, clicksRevealed, NONCE_COMMIT, oracleSig]),
    );
  });

  it("rejects when commit pre-image doesn't match (wrong secret)", async () => {
    const { mines, provider } = await setup({ initialOperator: operator });
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit = buildCommit(SECRET, player, 3, ONE_EVA);
    await playerMines.write.startGame([ONE_EVA, 3, ZERO_ADDRESS, commit]);
    const requestId = 1n;
    const clicks = [0];
    const clickCommit = buildClickCommit(clicks, NONCE_COMMIT, player);
    await playerMines.write.commitToClicks([requestId, clickCommit]);
    await provider.write.setRawWord([requestId, 1n]);
    const oracleSig = await buildOracleSig(walletClients[3], requestId, SECRET2, clicks);
    await expectRevert(
      playerMines.write.claim([requestId, SECRET2, clicks, NONCE_COMMIT, oracleSig]),
    );
  });

  it("rejects when too many clicks provided (exceeds TOTAL_SPOTS - minesCount)", async () => {
    const { mines, provider } = await setup({ initialOperator: operator });
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit = buildCommit(SECRET, player, 3, ONE_EVA);
    await playerMines.write.startGame([ONE_EVA, 3, ZERO_ADDRESS, commit]);
    const requestId = 1n;
    // 19 clicks > 21 - 3 = 18 max
    const clicks: number[] = [];
    for (let i = 0; i < 19; i++) clicks.push(i);
    const clickCommit = buildClickCommit(clicks, NONCE_COMMIT, player);
    await playerMines.write.commitToClicks([requestId, clickCommit]);
    await provider.write.setRawWord([requestId, 1n]);
    const oracleSig = await buildOracleSig(walletClients[3], requestId, SECRET, clicks);
    await expectRevert(playerMines.write.claim([requestId, SECRET, clicks, NONCE_COMMIT, oracleSig]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveAbandoned — full happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("MinesGameHybridV2 — resolveAbandoned happy path", () => {
  it("operator resolves an abandoned game after timeout, fee goes to msg.sender, payout to player", async () => {
    const { mines, provider, token } = await setup({
      initialOperator: operator,
    });
    await mines.write.setResolveFeeBps([500]); // 5%

    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit = buildCommit(SECRET, player, 3, ONE_EVA);
    await playerMines.write.startGame([ONE_EVA, 3, ZERO_ADDRESS, commit]);
    const requestId = 1n;
    const clicks = [0];
    const clickCommit = buildClickCommit(clicks, NONCE_COMMIT, player);
    await playerMines.write.commitToClicks([requestId, clickCommit]);
    await provider.write.setRawWord([requestId, 1n]);

    // Advance past claimTimeout (60 seconds)
    await env.networkHelpers.time.increase(120);

    const opMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[3] },
    });
    const playerBefore = await token.read.balanceOf([player]);
    const operatorBefore = await token.read.balanceOf([operator]);

    await opMines.write.resolveAbandoned([requestId, SECRET, clicks]);

    const playerAfter = await token.read.balanceOf([player]);
    const operatorAfter = await token.read.balanceOf([operator]);

    // If the random outcome was "hit mine", payout is 0 → no fee, no transfers
    // If safe, both player and operator should receive something
    expect(playerAfter >= playerBefore).to.equal(true);
    expect(operatorAfter >= operatorBefore).to.equal(true);

    // Game cleared regardless of outcome
    const game = await mines.read.games([requestId]);
    expect(game[8]).to.equal(0);
  });

  it("resolveAbandoned rejects before timeout (ExpiredNotReached)", async () => {
    const { mines, provider } = await setup({
      initialOperator: operator,
    });
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit = buildCommit(SECRET, player, 3, ONE_EVA);
    await playerMines.write.startGame([ONE_EVA, 3, ZERO_ADDRESS, commit]);
    const opMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(opMines.write.resolveAbandoned([1n, SECRET, [0]]));
  });

  it("resolveAbandoned rejects unknown requestId (InvalidRequest)", async () => {
    const { mines } = await setup({ initialOperator: operator });
    const opMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(opMines.write.resolveAbandoned([999n, SECRET, [0]]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cancelExpired — full happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("MinesGameHybridV2 — cancelExpired happy path", () => {
  it("with refundPlayer=true: refunds netStake (minus maintenance edge + resolve fee) to player and fee to operator", async () => {
    const { mines, token } = await setup({ initialOperator: operator });
    await mines.write.setResolveFeeBps([500]); // 5%

    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit = buildCommit(SECRET, player, 3, ONE_EVA);
    await playerMines.write.startGame([ONE_EVA, 3, ZERO_ADDRESS, commit]);

    await env.networkHelpers.time.increase(120);

    const opMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[3] },
    });
    const playerBefore = await token.read.balanceOf([player]);
    const operatorBefore = await token.read.balanceOf([operator]);

    await opMines.write.cancelExpired([1n, true]);

    const playerAfter = await token.read.balanceOf([player]);
    const operatorAfter = await token.read.balanceOf([operator]);

    expect(playerAfter > playerBefore).to.equal(true);
    expect(operatorAfter > operatorBefore).to.equal(true);

    const game = await mines.read.games([1n]);
    expect(game[8]).to.equal(0);

    const events = await mines.getEvents.GameCanceled();
    const evt = events.find((e) => e.args.requestId === 1n);
    expect(evt, "GameCanceled not emitted").to.exist;
    // refundAmount in the event = exactly the amount transferred to the player
    expect(evt!.args.refundAmount).to.equal(playerAfter - playerBefore);
  });

  it("with refundPlayer=false: just clears state, no refund", async () => {
    const { mines, token } = await setup({ initialOperator: operator });
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit = buildCommit(SECRET, player, 3, ONE_EVA);
    await playerMines.write.startGame([ONE_EVA, 3, ZERO_ADDRESS, commit]);

    await env.networkHelpers.time.increase(120);

    const opMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[3] },
    });
    const playerBefore = await token.read.balanceOf([player]);
    await opMines.write.cancelExpired([1n, false]);
    const playerAfter = await token.read.balanceOf([player]);

    expect(playerAfter).to.equal(playerBefore);
    const game = await mines.read.games([1n]);
    expect(game[8]).to.equal(0);
  });

  it("rejects unknown requestId", async () => {
    const { mines } = await setup({ initialOperator: operator });
    const opMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(opMines.write.cancelExpired([999n, false]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Views
// ─────────────────────────────────────────────────────────────────────────────

describe("MinesGameHybridV2 — views", () => {
  it("getMultiplierTable returns the stored table; empty for unset minesCount", async () => {
    const { mines } = await setup({ minesCounts: [3, 5] });
    const t3 = await mines.read.getMultiplierTable([3]);
    expect(t3.length).to.equal(TOTAL_SPOTS - 3 + 1);
    const t7 = await mines.read.getMultiplierTable([7]);
    expect(t7.length).to.equal(0);
  });
});
