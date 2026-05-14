import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";
import { encodePacked, keccak256 } from "viem";

import { ZERO_ADDRESS, ONE_EVA, HUNDRED_EVA, ONE_THOUSAND_EVA } from "../helpers/constants.js";
import { expectRevert } from "../helpers/utils.js";

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;
let publicClient: Awaited<ReturnType<typeof env.viem.getPublicClient>>;
let chainId: number;

let deployer: `0x${string}`;
let player: `0x${string}`;
let sessionKey: `0x${string}`;
let operator: `0x${string}`;
let feeRecipient: `0x${string}`;
let defaultRcv: `0x${string}`;
let other: `0x${string}`;

const HOUSE_BPS = 200;
const REFERRAL_BPS = 200;
const JACKPOT_BPS = 0;

const SECRET = ("0x" + "aa".repeat(32)) as `0x${string}`;
const NONCE_COMMIT = ("0x" + "11".repeat(32)) as `0x${string}`;

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  publicClient = await env.viem.getPublicClient();
  chainId = await publicClient.getChainId();

  deployer = walletClients[0].account.address;
  player = walletClients[1].account.address;
  sessionKey = walletClients[2].account.address;
  operator = walletClients[3].account.address;
  feeRecipient = walletClients[4].account.address;
  defaultRcv = walletClients[5].account.address;
  other = walletClients[6].account.address;
});

async function nowOnChain(): Promise<bigint> {
  const block = await publicClient.getBlock();
  return block.timestamp;
}

async function setup(opts: { initialOperator?: `0x${string}` } = {}) {
  const token = await env.viem.deployContract("EverValueCoin");
  const handler = await env.viem.deployContract("PaymentHandler", [token.address]);
  const mlr = await env.viem.deployContract("MultiLevelReferral", [token.address, defaultRcv]);
  await mlr.write.setLevels([1, [10000]]);
  await mlr.write.setPaymentHandler([handler.address]);
  await handler.write.setReferralContract([mlr.address]);

  const provider = await env.viem.deployContract("MockMinesRandomProvider");
  const authHub = await env.viem.deployContract("AuthHub");

  const mines = await env.viem.deployContract("MinesGameHybridV2", [
    token.address,
    handler.address,
    provider.address,
    authHub.address,
    opts.initialOperator ?? ZERO_ADDRESS,
  ]);

  await handler.write.registerGame([
    mines.address, mines.address, feeRecipient,
    HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS,
  ]);

  await authHub.write.setOperator([operator, true]);
  await authHub.write.setSpendTracker([mines.address, true]);

  // Enable a table config
  await mines.write.setTableConfig([{
    enabled: true,
    minMines: 3,
    maxMines: 5,
    minWager: 0n,
    maxWager: 0n,
    claimTimeout: 60, // seconds
  } as any]);

  // Multiplier table for minesCount = 3 — needs (TOTAL_SPOTS - 3) + 1 = 19 entries.
  // First entry must be >= MULTIPLIER_SCALE (100); each subsequent entry must be >= previous.
  const mults: number[] = [];
  for (let i = 0; i < 19; i++) mults.push(100 + i * 10);
  await mines.write.setMultiplierTable([3, mults]);

  // Fund player + approve mines
  await token.write.transfer([player, HUNDRED_EVA * 5n]);
  const playerToken = await env.viem.getContractAt("EverValueCoin", token.address, {
    client: { wallet: walletClients[1] },
  });
  await playerToken.write.approve([mines.address, ONE_THOUSAND_EVA]);

  // Bankroll
  await token.write.transfer([mines.address, ONE_THOUSAND_EVA * 5n]);

  return { token, handler, provider, authHub, mines };
}

async function authorizeSessionKey(authHubAddress: `0x${string}`, spendCap: bigint = 0n, expiresAt: bigint = 0n) {
  const playerHub = await env.viem.getContractAt("AuthHub", authHubAddress, {
    client: { wallet: walletClients[1] },
  });
  await playerHub.write.authorize([sessionKey, expiresAt, spendCap]);
}

function buildCommit(secret: `0x${string}`, playerAddr: `0x${string}`, minesCount: number, wager: bigint): `0x${string}` {
  return keccak256(
    encodePacked(["bytes32", "address", "uint8", "uint256"], [secret, playerAddr, minesCount, wager]),
  );
}

function buildClickCommit(clicks: number[], nonce: `0x${string}`, playerAddr: `0x${string}`): `0x${string}` {
  return keccak256(
    encodePacked(
      ["uint8[]", "bytes32", "address"],
      [clicks, nonce, playerAddr],
    ),
  );
}

async function buildOracleSig(
  signerWallet: (typeof walletClients)[number],
  requestId: bigint,
  secret: `0x${string}`,
  clicks: number[],
): Promise<`0x${string}`> {
  // Mines accepts ECDSA over toEthSignedMessageHash(keccak256(requestId, secret, clicks))
  const innerHash = keccak256(
    encodePacked(["uint256", "bytes32", "uint8[]"], [requestId, secret, clicks]),
  );
  return signerWallet.signMessage({ message: { raw: innerHash } });
}

// EIP-712 signing helpers for the three *For variants

async function signStartGame(
  signerWallet: (typeof walletClients)[number],
  minesAddress: `0x${string}`,
  message: {
    game: `0x${string}`;
    player: `0x${string}`;
    wager: bigint;
    minesCount: number;
    potentialReferrer: `0x${string}`;
    commit: `0x${string}`;
    nonce: bigint;
    deadline: bigint;
  },
) {
  return signerWallet.signTypedData({
    domain: {
      name: "MinesGameHybridV2",
      version: "1",
      chainId,
      verifyingContract: minesAddress,
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
    message,
  });
}

async function signCommitClicks(
  signerWallet: (typeof walletClients)[number],
  minesAddress: `0x${string}`,
  message: {
    game: `0x${string}`;
    player: `0x${string}`;
    requestId: bigint;
    clickCommit: `0x${string}`;
    nonce: bigint;
    deadline: bigint;
  },
) {
  return signerWallet.signTypedData({
    domain: {
      name: "MinesGameHybridV2",
      version: "1",
      chainId,
      verifyingContract: minesAddress,
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
    message,
  });
}

async function signClaim(
  signerWallet: (typeof walletClients)[number],
  minesAddress: `0x${string}`,
  message: {
    game: `0x${string}`;
    player: `0x${string}`;
    requestId: bigint;
    secret: `0x${string}`;
    clicksHash: `0x${string}`;
    nonceCommit: `0x${string}`;
    nonce: bigint;
    deadline: bigint;
  },
) {
  return signerWallet.signTypedData({
    domain: {
      name: "MinesGameHybridV2",
      version: "1",
      chainId,
      verifyingContract: minesAddress,
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
    message,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTRUCTOR
// ─────────────────────────────────────────────────────────────────────────────

describe("MinesGameHybridV2 — constructor", () => {
  it("seeds initial operator when non-zero (operator allowlist used for both lifecycle and attestation)", async () => {
    const { mines } = await setup({ initialOperator: operator });
    expect(await mines.read.gameOperators([operator])).to.equal(true);
  });

  it("does not seed when initialOperator is zero", async () => {
    const { mines } = await setup();
    expect(await mines.read.gameOperators([operator])).to.equal(false);
  });

  it("wires AuthHub and exposes EIP-712 domain separator", async () => {
    const { mines, authHub } = await setup();
    expect((await mines.read.authHub()).toLowerCase()).to.equal(authHub.address.toLowerCase());
    const sep = await mines.read.domainSeparator();
    expect(sep).to.not.equal("0x" + "00".repeat(32));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// startGame (direct) + startGameFor
// ─────────────────────────────────────────────────────────────────────────────

describe("MinesGameHybridV2 — startGame / startGameFor", () => {
  it("startGame: places a game and emits GameStarted", async () => {
    const { mines } = await setup();
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const wager = ONE_EVA;
    const commit = buildCommit(SECRET, player, 3, wager);
    const txHash = await playerMines.write.startGame([wager, 3, ZERO_ADDRESS, commit]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    const events = await mines.getEvents.GameStarted();
    const evt = events.find((e) => e.args.player?.toLowerCase() === player.toLowerCase());
    expect(evt, "GameStarted not emitted").to.exist;
    expect(evt!.args.wager).to.equal(wager);
    expect(evt!.args.minesCount).to.equal(3);
  });

  it("startGameFor: happy path verifies signature, charges spend cap, increments nonce", async () => {
    const { mines, authHub } = await setup({ initialOperator: operator });
    await authorizeSessionKey(authHub.address, HUNDRED_EVA);
    const wager = ONE_EVA;
    const commit = buildCommit(SECRET, player, 3, wager);
    const t = await nowOnChain();
    const sig = await signStartGame(walletClients[2], mines.address, {
      game: mines.address, player, wager, minesCount: 3,
      potentialReferrer: ZERO_ADDRESS, commit, nonce: 0n, deadline: t + 60n,
    });
    const opMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[3] },
    });
    await opMines.write.startGameFor([
      player, wager, 3, ZERO_ADDRESS, commit, 0n, t + 60n, sig,
    ]);
    expect(await mines.read.actionNonces([player])).to.equal(1n);
    expect(await authHub.read.remainingSpend([player])).to.equal(HUNDRED_EVA - wager);
  });

  it("startGameFor: rejects non-operator caller", async () => {
    const { mines, authHub } = await setup();
    await authorizeSessionKey(authHub.address);
    const commit = buildCommit(SECRET, player, 3, ONE_EVA);
    const t = await nowOnChain();
    const sig = await signStartGame(walletClients[2], mines.address, {
      game: mines.address, player, wager: ONE_EVA, minesCount: 3, potentialReferrer: ZERO_ADDRESS, commit, nonce: 0n, deadline: t + 60n,
    });
    const asOther = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(
      asOther.write.startGameFor([player, ONE_EVA, 3, ZERO_ADDRESS, commit, 0n, t + 60n, sig]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// commitToClicks (direct) + commitToClicksFor
// ─────────────────────────────────────────────────────────────────────────────

describe("MinesGameHybridV2 — commitToClicks / commitToClicksFor", () => {
  it("commitToClicks: stores commit and emits event", async () => {
    const { mines } = await setup();
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const wager = ONE_EVA;
    const commit = buildCommit(SECRET, player, 3, wager);
    await playerMines.write.startGame([wager, 3, ZERO_ADDRESS, commit]);

    const clicks = [0, 1, 2];
    const clickCommit = buildClickCommit(clicks, NONCE_COMMIT, player);
    await playerMines.write.commitToClicks([1n, clickCommit]);

    const game = await mines.read.games([1n]);
    // games returns: (player, wager, netStake, lockedAmount, startedAt, minesCount, commit, clickCommit, status)
    expect(game[7]).to.equal(clickCommit);
  });

  it("commitToClicksFor: happy path (no spend, only nonce + sig)", async () => {
    const { mines, authHub } = await setup({ initialOperator: operator });
    await authorizeSessionKey(authHub.address);
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const wager = ONE_EVA;
    const commit = buildCommit(SECRET, player, 3, wager);
    await playerMines.write.startGame([wager, 3, ZERO_ADDRESS, commit]);

    const clicks = [0, 1, 2];
    const clickCommit = buildClickCommit(clicks, NONCE_COMMIT, player);
    const t = await nowOnChain();
    const sig = await signCommitClicks(walletClients[2], mines.address, {
      game: mines.address, player, requestId: 1n, clickCommit, nonce: 0n, deadline: t + 60n,
    });
    const opMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[3] },
    });
    await opMines.write.commitToClicksFor([player, 1n, clickCommit, 0n, t + 60n, sig]);
    expect(await mines.read.actionNonces([player])).to.equal(1n);
  });

  it("commitToClicksFor: rejects non-operator", async () => {
    const { mines, authHub } = await setup();
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const sig = await signCommitClicks(walletClients[2], mines.address, {
      game: mines.address, player, requestId: 1n, clickCommit: NONCE_COMMIT, nonce: 0n, deadline: t + 60n,
    });
    const asOther = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(asOther.write.commitToClicksFor([player, 1n, NONCE_COMMIT, 0n, t + 60n, sig]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// claim / claimFor (full game flow)
// ─────────────────────────────────────────────────────────────────────────────

describe("MinesGameHybridV2 — claim / claimFor", () => {
  it("claim: full happy path with valid operator attestation", async () => {
    const { mines, provider, token } = await setup({ initialOperator: operator });
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const wager = ONE_EVA;
    const commit = buildCommit(SECRET, player, 3, wager);
    await playerMines.write.startGame([wager, 3, ZERO_ADDRESS, commit]);
    const requestId = 1n;

    const clicks = [0, 1];
    const clickCommit = buildClickCommit(clicks, NONCE_COMMIT, player);
    await playerMines.write.commitToClicks([requestId, clickCommit]);

    // Seed VRF word
    await provider.write.setRawWord([requestId, 0xdeadbeefn]);

    // Operator attestation (operator is in gameOperators allowlist)
    const attestationSig = await buildOracleSig(walletClients[3], requestId, SECRET, clicks);

    const before = await token.read.balanceOf([player]);
    await playerMines.write.claim([requestId, SECRET, clicks, NONCE_COMMIT, attestationSig]);
    // Either hit a mine (no payout) or got a payout — both are valid; just confirm settlement happened.
    const after = await token.read.balanceOf([player]);
    expect(after >= before).to.equal(true);

    // Game should be deleted (status = None)
    const game = await mines.read.games([requestId]);
    expect(game[8]).to.equal(0); // GameStatus.None
  });

  it("claim: rejects when attestation signer is not a registered operator", async () => {
    const { mines, provider } = await setup({ initialOperator: operator });
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const wager = ONE_EVA;
    const commit = buildCommit(SECRET, player, 3, wager);
    await playerMines.write.startGame([wager, 3, ZERO_ADDRESS, commit]);
    const requestId = 1n;
    const clicks = [0, 1];
    const clickCommit = buildClickCommit(clicks, NONCE_COMMIT, player);
    await playerMines.write.commitToClicks([requestId, clickCommit]);
    await provider.write.setRawWord([requestId, 0xdeadbeefn]);

    // Sign with a wallet NOT in gameOperators — should revert NotGameOperator
    const badSig = await buildOracleSig(walletClients[8], requestId, SECRET, clicks);
    await expectRevert(playerMines.write.claim([requestId, SECRET, clicks, NONCE_COMMIT, badSig]));
  });

  it("claim: rejects when no operators are allowlisted (NotGameOperator)", async () => {
    const { mines, provider } = await setup(); // no operator seeded
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const wager = ONE_EVA;
    const commit = buildCommit(SECRET, player, 3, wager);
    await playerMines.write.startGame([wager, 3, ZERO_ADDRESS, commit]);
    const requestId = 1n;
    const clicks = [0, 1];
    const clickCommit = buildClickCommit(clicks, NONCE_COMMIT, player);
    await playerMines.write.commitToClicks([requestId, clickCommit]);
    await provider.write.setRawWord([requestId, 0xdeadbeefn]);

    // Even a syntactically valid signature from the operator wallet fails
    // because no addresses are allowlisted on this fresh deploy.
    const attestationSig = await buildOracleSig(walletClients[3], requestId, SECRET, clicks);
    await expectRevert(playerMines.write.claim([requestId, SECRET, clicks, NONCE_COMMIT, attestationSig]));
  });

  it("claimFor: full delegated claim succeeds with valid auth + operator attestation", async () => {
    const { mines, provider, authHub } = await setup({ initialOperator: operator });
    await authorizeSessionKey(authHub.address);
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const wager = ONE_EVA;
    const commit = buildCommit(SECRET, player, 3, wager);
    await playerMines.write.startGame([wager, 3, ZERO_ADDRESS, commit]);
    const requestId = 1n;
    const clicks = [0, 1];
    const clickCommit = buildClickCommit(clicks, NONCE_COMMIT, player);
    await playerMines.write.commitToClicks([requestId, clickCommit]);
    await provider.write.setRawWord([requestId, 0xdeadbeefn]);

    const attestationSig = await buildOracleSig(walletClients[3], requestId, SECRET, clicks);
    const t = await nowOnChain();
    const clicksHash = keccak256(encodePacked(["uint8[]"], [clicks]));
    const authSig = await signClaim(walletClients[2], mines.address, {
      game: mines.address, player, requestId, secret: SECRET, clicksHash, nonceCommit: NONCE_COMMIT,
      nonce: 0n, deadline: t + 60n,
    });
    const opMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[3] },
    });
    await opMines.write.claimFor([
      player, requestId, SECRET, clicks, NONCE_COMMIT, attestationSig, 0n, t + 60n, authSig,
    ]);

    expect(await mines.read.actionNonces([player])).to.equal(1n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveAbandoned & cancelExpired (operator-gated lifecycle)
// ─────────────────────────────────────────────────────────────────────────────

describe("MinesGameHybridV2 — lifecycle (resolveAbandoned, cancelExpired)", () => {
  it("resolveAbandoned: rejects non-operator caller", async () => {
    const { mines } = await setup(); // no operator seeded
    await expectRevert(mines.write.resolveAbandoned([1n, SECRET, [0, 1]]));
  });

  it("cancelExpired: rejects non-operator caller", async () => {
    const { mines } = await setup();
    await expectRevert(mines.write.cancelExpired([1n, false]));
  });

  it("cancelExpired: rejects when called too early (ExpiredNotReached)", async () => {
    const { mines } = await setup({ initialOperator: operator });
    const playerMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[1] },
    });
    const commit = buildCommit(SECRET, player, 3, ONE_EVA);
    await playerMines.write.startGame([ONE_EVA, 3, ZERO_ADDRESS, commit]);
    const opMines = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(opMines.write.cancelExpired([1n, false]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Operator setters smoke
// ─────────────────────────────────────────────────────────────────────────────

describe("MinesGameHybridV2 — operator setters (smoke)", () => {
  it("owner can rotate operators", async () => {
    const { mines } = await setup({ initialOperator: operator });
    await mines.write.setGameOperator([operator, false]);
    expect(await mines.read.gameOperators([operator])).to.equal(false);
    const opB = walletClients[8].account.address;
    await mines.write.setGameOperators([[opB], true]);
    expect(await mines.read.gameOperators([opB])).to.equal(true);
  });

  it("non-owner cannot rotate operators", async () => {
    const { mines } = await setup();
    const asOther = await env.viem.getContractAt("MinesGameHybridV2", mines.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(asOther.write.setGameOperator([operator, true]), "Ownable: caller is not the owner");
  });
});
