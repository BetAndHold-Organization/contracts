import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";

import { ZERO_ADDRESS } from "../helpers/constants.js";
import { expectRevert } from "../helpers/utils.js";

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;
let publicClient: Awaited<ReturnType<typeof env.viem.getPublicClient>>;
let chainId: number;

let deployer: `0x${string}`;
let player: `0x${string}`;
let sessionKeyAddr: `0x${string}`;
let operator: `0x${string}`;
let game: `0x${string}`;     // wallet acting as a registered spend tracker
let other: `0x${string}`;

const ONE_DAY = 86400n;

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  publicClient = await env.viem.getPublicClient();
  chainId = await publicClient.getChainId();

  deployer = walletClients[0].account.address;
  player = walletClients[1].account.address;
  sessionKeyAddr = walletClients[2].account.address;
  operator = walletClients[3].account.address;
  game = walletClients[4].account.address;
  other = walletClients[5].account.address;
});

async function freshHub() {
  return env.viem.deployContract("AuthHub");
}

/**
 * Compute current block timestamp on the local network. Useful for choosing
 * expiration / deadline values that won't drift with each tx.
 */
async function nowOnChain(): Promise<bigint> {
  const block = await publicClient.getBlock();
  return block.timestamp;
}

/**
 * Builds an EIP-712 signature for AuthHub.authorizeFor.
 *
 * Wallet client must be the PLAYER (the one whose authorization is being submitted).
 */
async function signAuthorize(
  walletClient: (typeof walletClients)[number],
  authHubAddress: `0x${string}`,
  message: {
    player: `0x${string}`;
    sessionKey: `0x${string}`;
    expiresAt: bigint;
    spendCap: bigint;
    nonce: bigint;
    deadline: bigint;
  },
): Promise<`0x${string}`> {
  return walletClient.signTypedData({
    domain: {
      name: "BurningGamesAuthHub",
      version: "1",
      chainId,
      verifyingContract: authHubAddress,
    },
    types: {
      Authorize: [
        { name: "player", type: "address" },
        { name: "sessionKey", type: "address" },
        { name: "expiresAt", type: "uint64" },
        { name: "spendCap", type: "uint128" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Authorize",
    message,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTRUCTOR + DEFAULTS
// ─────────────────────────────────────────────────────────────────────────────

describe("AuthHub — constructor + defaults", () => {
  it("deploys with sensible defaults: maxExpirationDelta = 0 (no cap)", async () => {
    const hub = await freshHub();
    expect(await hub.read.maxExpirationDelta()).to.equal(0n);
    expect(await hub.read.AUTHORIZE_TYPEHASH()).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("exposes a non-zero EIP-712 domain separator", async () => {
    const hub = await freshHub();
    const sep = await hub.read.domainSeparator();
    expect(sep).to.not.equal("0x" + "00".repeat(32));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OPERATOR MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

describe("AuthHub — setOperator / setOperators", () => {
  it("setOperator: rejects non-owner", async () => {
    const hub = await freshHub();
    const asOther = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.setOperator([operator, true]));
  });

  it("setOperator: rejects zero address", async () => {
    const hub = await freshHub();
    await expectRevert(hub.write.setOperator([ZERO_ADDRESS, true]), "Invalid operator");
  });

  it("setOperator: grants and revokes operator status", async () => {
    const hub = await freshHub();
    expect(await hub.read.isOperator([operator])).to.equal(false);
    await hub.write.setOperator([operator, true]);
    expect(await hub.read.isOperator([operator])).to.equal(true);
    await hub.write.setOperator([operator, false]);
    expect(await hub.read.isOperator([operator])).to.equal(false);
  });

  it("setOperators: rejects non-owner", async () => {
    const hub = await freshHub();
    const asOther = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.setOperators([[operator, other], true]));
  });

  it("setOperators: rejects zero address in batch", async () => {
    const hub = await freshHub();
    await expectRevert(hub.write.setOperators([[operator, ZERO_ADDRESS], true]), "Invalid operator");
  });

  it("setOperators: applies status to all addresses in batch", async () => {
    const hub = await freshHub();
    await hub.write.setOperators([[operator, other], true]);
    expect(await hub.read.isOperator([operator])).to.equal(true);
    expect(await hub.read.isOperator([other])).to.equal(true);
    await hub.write.setOperators([[operator, other], false]);
    expect(await hub.read.isOperator([operator])).to.equal(false);
    expect(await hub.read.isOperator([other])).to.equal(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPEND TRACKER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

describe("AuthHub — setSpendTracker / setSpendTrackers", () => {
  it("setSpendTracker: rejects non-owner", async () => {
    const hub = await freshHub();
    const asOther = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.setSpendTracker([game, true]));
  });

  it("setSpendTracker: rejects zero address", async () => {
    const hub = await freshHub();
    await expectRevert(hub.write.setSpendTracker([ZERO_ADDRESS, true]), "Invalid game");
  });

  it("setSpendTracker: grants and revokes tracker status", async () => {
    const hub = await freshHub();
    expect(await hub.read.spendTrackers([game])).to.equal(false);
    await hub.write.setSpendTracker([game, true]);
    expect(await hub.read.spendTrackers([game])).to.equal(true);
    await hub.write.setSpendTracker([game, false]);
    expect(await hub.read.spendTrackers([game])).to.equal(false);
  });

  it("setSpendTrackers: rejects non-owner", async () => {
    const hub = await freshHub();
    const asOther = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.setSpendTrackers([[game, other], true]));
  });

  it("setSpendTrackers: rejects zero address in batch", async () => {
    const hub = await freshHub();
    await expectRevert(hub.write.setSpendTrackers([[game, ZERO_ADDRESS], true]), "Invalid game");
  });

  it("setSpendTrackers: applies status to all addresses in batch", async () => {
    const hub = await freshHub();
    await hub.write.setSpendTrackers([[game, other], true]);
    expect(await hub.read.spendTrackers([game])).to.equal(true);
    expect(await hub.read.spendTrackers([other])).to.equal(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MAX EXPIRATION DELTA
// ─────────────────────────────────────────────────────────────────────────────

describe("AuthHub — setMaxExpirationDelta", () => {
  it("rejects non-owner", async () => {
    const hub = await freshHub();
    const asOther = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.setMaxExpirationDelta([ONE_DAY * 30n]));
  });

  it("updates and exposes via storage", async () => {
    const hub = await freshHub();
    await hub.write.setMaxExpirationDelta([ONE_DAY * 30n]);
    expect(await hub.read.maxExpirationDelta()).to.equal(ONE_DAY * 30n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHORIZE (player-callable)
// ─────────────────────────────────────────────────────────────────────────────

describe("AuthHub — authorize (player-callable)", () => {
  it("rejects zero session key", async () => {
    const hub = await freshHub();
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asPlayer.write.authorize([ZERO_ADDRESS, 0n, 0n]));
  });

  it("rejects session key equal to player (self-authorization)", async () => {
    const hub = await freshHub();
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asPlayer.write.authorize([player, 0n, 0n]));
  });

  it("rejects past expiration when no admin cap is set", async () => {
    const hub = await freshHub();
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    const past = (await nowOnChain()) - 1n;
    await expectRevert(asPlayer.write.authorize([sessionKeyAddr, past, 0n]));
  });

  it("accepts expiresAt = 0 (never expires) when no admin cap is set", async () => {
    const hub = await freshHub();
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await asPlayer.write.authorize([sessionKeyAddr, 0n, 0n]);
    expect((await hub.read.keys([player]))[1]).to.equal(0n); // expiresAt = 0
    expect((await hub.read.sessionKeyOf([player])).toLowerCase()).to.equal(sessionKeyAddr.toLowerCase());
  });

  it("stores key with spent counter zero", async () => {
    const hub = await freshHub();
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await asPlayer.write.authorize([sessionKeyAddr, 0n, 100n]);
    const ka = await hub.read.keys([player]);
    expect(ka[2]).to.equal(100n);  // spendCap
    expect(ka[3]).to.equal(0n);    // spent
  });

  it("re-authorize replaces session key and resets spent counter", async () => {
    const hub = await freshHub();
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await hub.write.setSpendTracker([game, true]);
    await asPlayer.write.authorize([sessionKeyAddr, 0n, 100n]);
    // Simulate spending via game (acting as spend tracker)
    const asGame = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[4] },
    });
    await asGame.write.recordSpending([player, 50n]);
    expect((await hub.read.keys([player]))[3]).to.equal(50n);

    // Re-authorize with new key + new cap → spent resets to 0
    await asPlayer.write.authorize([other, 0n, 200n]);
    const ka = await hub.read.keys([player]);
    expect(ka[0].toLowerCase()).to.equal(other.toLowerCase());
    expect(ka[2]).to.equal(200n);
    expect(ka[3]).to.equal(0n);
  });

  it("when admin cap is set, expiresAt = 0 is silently clamped to now + maxDelta", async () => {
    const hub = await freshHub();
    await hub.write.setMaxExpirationDelta([ONE_DAY * 30n]);
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    const t0 = await nowOnChain();
    await asPlayer.write.authorize([sessionKeyAddr, 0n, 0n]);
    const stored = (await hub.read.keys([player]))[1];
    // expiresAt should be ~ t0 + 30 days (allow ±2s drift)
    const expected = t0 + ONE_DAY * 30n;
    expect(stored >= expected - 2n && stored <= expected + 2n).to.equal(true);
  });

  it("when admin cap is set, expiresAt > now+maxDelta is silently clamped", async () => {
    const hub = await freshHub();
    await hub.write.setMaxExpirationDelta([ONE_DAY * 30n]);
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    const t0 = await nowOnChain();
    const farFuture = t0 + ONE_DAY * 365n; // 1 year
    await asPlayer.write.authorize([sessionKeyAddr, farFuture, 0n]);
    const stored = (await hub.read.keys([player]))[1];
    expect(stored < farFuture).to.equal(true);
    expect(stored <= t0 + ONE_DAY * 30n + 2n).to.equal(true);
  });

  it("emits SessionKeyAuthorized with stored values", async () => {
    const hub = await freshHub();
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    const t = (await nowOnChain()) + ONE_DAY;
    await asPlayer.write.authorize([sessionKeyAddr, t, 1000n]);
    // Indirect: state matches
    const ka = await hub.read.keys([player]);
    expect(ka[0].toLowerCase()).to.equal(sessionKeyAddr.toLowerCase());
    expect(ka[1]).to.equal(t);
    expect(ka[2]).to.equal(1000n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REVOKE
// ─────────────────────────────────────────────────────────────────────────────

describe("AuthHub — revoke", () => {
  it("rejects when no session key is set", async () => {
    const hub = await freshHub();
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asPlayer.write.revoke());
  });

  it("clears the key and emits SessionKeyRevoked", async () => {
    const hub = await freshHub();
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await asPlayer.write.authorize([sessionKeyAddr, 0n, 0n]);
    expect((await hub.read.sessionKeyOf([player])).toLowerCase()).to.equal(sessionKeyAddr.toLowerCase());
    await asPlayer.write.revoke();
    expect(await hub.read.sessionKeyOf([player])).to.equal(ZERO_ADDRESS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHORIZE FOR (meta-tx)
// ─────────────────────────────────────────────────────────────────────────────

describe("AuthHub — authorizeFor (meta-tx)", () => {
  it("rejects expired deadline", async () => {
    const hub = await freshHub();
    const t = await nowOnChain();
    const sig = await signAuthorize(walletClients[1], hub.address, {
      player, sessionKey: sessionKeyAddr, expiresAt: 0n, spendCap: 0n, nonce: 0n, deadline: t - 1n,
    });
    await expectRevert(
      hub.write.authorizeFor([player, sessionKeyAddr, 0n, 0n, 0n, t - 1n, sig]),
    );
  });

  it("rejects wrong nonce", async () => {
    const hub = await freshHub();
    const t = await nowOnChain();
    const sig = await signAuthorize(walletClients[1], hub.address, {
      player, sessionKey: sessionKeyAddr, expiresAt: 0n, spendCap: 0n, nonce: 5n, deadline: t + ONE_DAY,
    });
    await expectRevert(
      hub.write.authorizeFor([player, sessionKeyAddr, 0n, 0n, 5n, t + ONE_DAY, sig]),
    );
  });

  it("rejects signature signed by someone other than the player", async () => {
    const hub = await freshHub();
    const t = await nowOnChain();
    // walletClients[5] (other) signs but the message names walletClients[1] (player)
    const sig = await signAuthorize(walletClients[5], hub.address, {
      player, sessionKey: sessionKeyAddr, expiresAt: 0n, spendCap: 0n, nonce: 0n, deadline: t + ONE_DAY,
    });
    await expectRevert(
      hub.write.authorizeFor([player, sessionKeyAddr, 0n, 0n, 0n, t + ONE_DAY, sig]),
    );
  });

  it("happy path: operator submits player-signed authorization", async () => {
    const hub = await freshHub();
    const t = await nowOnChain();
    const expiry = t + ONE_DAY * 7n;
    const sig = await signAuthorize(walletClients[1], hub.address, {
      player, sessionKey: sessionKeyAddr, expiresAt: expiry, spendCap: 500n, nonce: 0n, deadline: t + ONE_DAY,
    });
    // Operator submits (any caller works since we just need to write the tx)
    const asOperator = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[3] },
    });
    await asOperator.write.authorizeFor([player, sessionKeyAddr, expiry, 500n, 0n, t + ONE_DAY, sig]);
    const ka = await hub.read.keys([player]);
    expect(ka[0].toLowerCase()).to.equal(sessionKeyAddr.toLowerCase());
    expect(ka[1]).to.equal(expiry);
    expect(ka[2]).to.equal(500n);
    expect(await hub.read.authNonces([player])).to.equal(1n);
  });

  it("nonce increments correctly across consecutive authorizations", async () => {
    const hub = await freshHub();
    const t = await nowOnChain();

    const sig1 = await signAuthorize(walletClients[1], hub.address, {
      player, sessionKey: sessionKeyAddr, expiresAt: 0n, spendCap: 0n, nonce: 0n, deadline: t + ONE_DAY,
    });
    await hub.write.authorizeFor([player, sessionKeyAddr, 0n, 0n, 0n, t + ONE_DAY, sig1]);
    expect(await hub.read.authNonces([player])).to.equal(1n);

    const sig2 = await signAuthorize(walletClients[1], hub.address, {
      player, sessionKey: other, expiresAt: 0n, spendCap: 0n, nonce: 1n, deadline: t + ONE_DAY,
    });
    await hub.write.authorizeFor([player, other, 0n, 0n, 1n, t + ONE_DAY, sig2]);
    expect(await hub.read.authNonces([player])).to.equal(2n);
    expect((await hub.read.sessionKeyOf([player])).toLowerCase()).to.equal(other.toLowerCase());
  });

  it("replay attempt with old signature reverts via nonce check", async () => {
    const hub = await freshHub();
    const t = await nowOnChain();
    const sig = await signAuthorize(walletClients[1], hub.address, {
      player, sessionKey: sessionKeyAddr, expiresAt: 0n, spendCap: 0n, nonce: 0n, deadline: t + ONE_DAY,
    });
    await hub.write.authorizeFor([player, sessionKeyAddr, 0n, 0n, 0n, t + ONE_DAY, sig]);
    // Replay
    await expectRevert(
      hub.write.authorizeFor([player, sessionKeyAddr, 0n, 0n, 0n, t + ONE_DAY, sig]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SESSION KEY EXPIRATION
// ─────────────────────────────────────────────────────────────────────────────

describe("AuthHub — sessionKeyOf expiration", () => {
  it("returns address(0) when not authorized", async () => {
    const hub = await freshHub();
    expect(await hub.read.sessionKeyOf([player])).to.equal(ZERO_ADDRESS);
  });

  it("returns address(0) after the expiry timestamp passes", async () => {
    const hub = await freshHub();
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    const t = await nowOnChain();
    const expiry = t + 10n;
    await asPlayer.write.authorize([sessionKeyAddr, expiry, 0n]);
    // Before expiry
    expect((await hub.read.sessionKeyOf([player])).toLowerCase()).to.equal(sessionKeyAddr.toLowerCase());
    // Move past expiry
    await env.networkHelpers.time.increaseTo(Number(expiry) + 1);
    expect(await hub.read.sessionKeyOf([player])).to.equal(ZERO_ADDRESS);
  });

  it("returns the key forever when expiresAt = 0", async () => {
    const hub = await freshHub();
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await asPlayer.write.authorize([sessionKeyAddr, 0n, 0n]);
    await env.networkHelpers.time.increase(Number(ONE_DAY * 365n)); // 1 year forward
    expect((await hub.read.sessionKeyOf([player])).toLowerCase()).to.equal(sessionKeyAddr.toLowerCase());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RECORD SPENDING + SPEND CAP
// ─────────────────────────────────────────────────────────────────────────────

describe("AuthHub — recordSpending + spend cap", () => {
  it("rejects callers not on the spendTrackers allowlist", async () => {
    const hub = await freshHub();
    const asOther = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[5] },
    });
    await expectRevert(asOther.write.recordSpending([player, 1n]));
  });

  it("returns silently (no-op) when player has unlimited cap (cap = 0)", async () => {
    const hub = await freshHub();
    await hub.write.setSpendTracker([game, true]);
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await asPlayer.write.authorize([sessionKeyAddr, 0n, 0n]); // cap = 0 → unlimited
    const asGame = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[4] },
    });
    await asGame.write.recordSpending([player, 1_000_000n]);
    expect((await hub.read.keys([player]))[3]).to.equal(0n); // spent unchanged
  });

  it("increments spent and stays within cap on multiple records", async () => {
    const hub = await freshHub();
    await hub.write.setSpendTracker([game, true]);
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await asPlayer.write.authorize([sessionKeyAddr, 0n, 100n]);
    const asGame = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[4] },
    });
    await asGame.write.recordSpending([player, 30n]);
    await asGame.write.recordSpending([player, 40n]);
    expect((await hub.read.keys([player]))[3]).to.equal(70n);
    expect(await hub.read.remainingSpend([player])).to.equal(30n);
  });

  it("reverts SpendCapExceeded when the bet would push spent past cap", async () => {
    const hub = await freshHub();
    await hub.write.setSpendTracker([game, true]);
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await asPlayer.write.authorize([sessionKeyAddr, 0n, 100n]);
    const asGame = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[4] },
    });
    await asGame.write.recordSpending([player, 80n]);
    await expectRevert(asGame.write.recordSpending([player, 30n])); // 80 + 30 > 100
    // First record stuck; second reverted; spent stays at 80
    expect((await hub.read.keys([player]))[3]).to.equal(80n);
  });

  it("remainingSpend: returns max for unlimited cap", async () => {
    const hub = await freshHub();
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await asPlayer.write.authorize([sessionKeyAddr, 0n, 0n]); // unlimited
    expect(await hub.read.remainingSpend([player])).to.equal(2n ** 256n - 1n);
  });

  it("remainingSpend: returns 0 when spent equals cap", async () => {
    const hub = await freshHub();
    await hub.write.setSpendTracker([game, true]);
    const asPlayer = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[1] },
    });
    await asPlayer.write.authorize([sessionKeyAddr, 0n, 50n]);
    const asGame = await env.viem.getContractAt("AuthHub", hub.address, {
      client: { wallet: walletClients[4] },
    });
    await asGame.write.recordSpending([player, 50n]);
    expect(await hub.read.remainingSpend([player])).to.equal(0n);
  });
});
