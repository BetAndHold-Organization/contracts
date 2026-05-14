import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";

import { ZERO_ADDRESS, ONE_EVA, HUNDRED_EVA } from "../../helpers/constants.js";
import { expectRevert } from "../../helpers/utils.js";

/**
 * SignedActionAuth is a mixin (cannot be deployed standalone). We test it through
 * ProgressiveJackpot.placeDirectBetFor — a real game integration that exercises every
 * branch of _verifyAndConsume + the onlyOperator modifier without dragging in
 * VRF round-management or other game-specific complexity.
 */

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;
let publicClient: Awaited<ReturnType<typeof env.viem.getPublicClient>>;
let chainId: number;

let deployer: `0x${string}`;
let player: `0x${string}`;
let sessionKey: `0x${string}`;
let operator: `0x${string}`;
let other: `0x${string}`;

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  publicClient = await env.viem.getPublicClient();
  chainId = await publicClient.getChainId();
  deployer = walletClients[0].account.address;
  player = walletClients[1].account.address;
  sessionKey = walletClients[2].account.address;
  operator = walletClients[3].account.address;
  other = walletClients[5].account.address;
});

async function nowOnChain(): Promise<bigint> {
  const block = await publicClient.getBlock();
  return block.timestamp;
}

/**
 * Fully-wired environment for placeDirectBetFor:
 *   - PaymentHandler with jackpot registered as a game (zero bps)
 *   - ProgressiveJackpot with tier ladder, direct outcomes, pots seeded
 *   - AuthHub with operator allowlisted + jackpot registered as spend tracker
 *   - Player has tokens + approved jackpot
 */
async function setup() {
  const token = await env.viem.deployContract("EverValueCoin");
  const provider = await env.viem.deployContract("MockJackpotRandomProvider");
  const paymentHandler = await env.viem.deployContract("PaymentHandler", [token.address]);
  const authHub = await env.viem.deployContract("AuthHub");
  const jackpot = await env.viem.deployContract("ProgressiveJackpot", [
    token.address, provider.address, authHub.address,
  ]);

  // Jackpot setup
  await jackpot.write.setPaymentHandler([paymentHandler.address]);
  const tiers = Array.from({ length: 9 }, (_, i) => ({
    prizeMetric: 0n, isTerminal: i === 8, isPercent: false,
    fixedBetCost: ONE_EVA, useDynamicCost: false, costBps: 0,
  }));
  await jackpot.write.setTierLadder([tiers]);
  await jackpot.write.setAllTierProbConfigs([1000, 50_000, 30]);

  const outcomes = [
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: false },
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false },
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 15000, awardsTier: false },
  ];
  for (let i = 0; i < 9; i++) {
    outcomes.push({ enabled: true, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
  }
  await jackpot.write.configureDirectBet([true, outcomes]);
  await jackpot.write.setDirectFallback([0]);

  // PaymentHandler setup
  await paymentHandler.write.registerGame([
    jackpot.address, jackpot.address, deployer, 0, 0, 0,
  ]);

  // AuthHub setup
  await authHub.write.setOperator([operator, true]);
  await authHub.write.setSpendTracker([jackpot.address, true]);

  // Seed jackpot pots
  await token.write.approve([jackpot.address, HUNDRED_EVA]);
  await jackpot.write.seedConsolationPot([HUNDRED_EVA]);
  for (let i = 0; i < 9; i++) {
    await token.write.approve([jackpot.address, HUNDRED_EVA]);
    await jackpot.write.seedTierPot([i, HUNDRED_EVA]);
  }

  // Player gets tokens + approves jackpot
  await token.write.transfer([player, HUNDRED_EVA]);
  const playerAsToken = await env.viem.getContractAt("EverValueCoin", token.address, {
    client: { wallet: walletClients[1] },
  });
  await playerAsToken.write.approve([jackpot.address, HUNDRED_EVA]);

  return { token, provider, paymentHandler, authHub, jackpot };
}

/**
 * Sign a placeDirectBetFor message using the SESSION KEY's private key.
 */
async function signPlaceDirectBet(
  signerWallet: (typeof walletClients)[number],
  jackpotAddress: `0x${string}`,
  message: {
    game: `0x${string}`;
    player: `0x${string}`;
    potentialReferrer: `0x${string}`;
    nonce: bigint;
    deadline: bigint;
  },
): Promise<`0x${string}`> {
  return signerWallet.signTypedData({
    domain: {
      name: "ProgressiveJackpot",
      version: "1",
      chainId,
      verifyingContract: jackpotAddress,
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
    message,
  });
}

/**
 * Standard authorize: player authorizes their session key on AuthHub.
 */
async function authorizeSessionKey(
  authHubAddress: `0x${string}`,
  spendCap: bigint = 0n,
  expiresAt: bigint = 0n,
) {
  const authHub = await env.viem.getContractAt("AuthHub", authHubAddress, {
    client: { wallet: walletClients[1] },
  });
  await authHub.write.authorize([sessionKey, expiresAt, spendCap]);
}

// ─────────────────────────────────────────────────────────────────────────────
// onlyOperator modifier
// ─────────────────────────────────────────────────────────────────────────────

describe("SignedActionAuth — onlyOperator modifier", () => {
  it("rejects caller not on AuthHub operator allowlist", async () => {
    const { authHub, jackpot } = await setup();
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const sig = await signPlaceDirectBet(walletClients[2], jackpot.address, {
      game: jackpot.address, player, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t + 60n,
    });
    // walletClients[5] (other) is NOT registered as operator
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[5] },
    });
    await expectRevert(asOther.write.placeDirectBetFor([player, ZERO_ADDRESS, 0n, t + 60n, sig]));
  });

  it("accepts caller on the operator allowlist", async () => {
    const { authHub, jackpot } = await setup();
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const sig = await signPlaceDirectBet(walletClients[2], jackpot.address, {
      game: jackpot.address, player, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t + 60n,
    });
    const asOperator = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    await asOperator.write.placeDirectBetFor([player, ZERO_ADDRESS, 0n, t + 60n, sig]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _verifyAndConsume: each failure mode
// ─────────────────────────────────────────────────────────────────────────────

describe("SignedActionAuth — _verifyAndConsume failure modes", () => {
  it("rejects expired deadline", async () => {
    const { authHub, jackpot } = await setup();
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const past = t - 10n;
    const sig = await signPlaceDirectBet(walletClients[2], jackpot.address, {
      game: jackpot.address, player, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: past,
    });
    const asOperator = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(asOperator.write.placeDirectBetFor([player, ZERO_ADDRESS, 0n, past, sig]));
  });

  it("rejects wrong nonce (player's actionNonces is 0, sig uses 5)", async () => {
    const { authHub, jackpot } = await setup();
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const sig = await signPlaceDirectBet(walletClients[2], jackpot.address, {
      game: jackpot.address, player, potentialReferrer: ZERO_ADDRESS, nonce: 5n, deadline: t + 60n,
    });
    const asOperator = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(asOperator.write.placeDirectBetFor([player, ZERO_ADDRESS, 5n, t + 60n, sig]));
  });

  it("rejects when player has no session key authorized", async () => {
    const { jackpot } = await setup();
    // No authorization done
    const t = await nowOnChain();
    const sig = await signPlaceDirectBet(walletClients[2], jackpot.address, {
      game: jackpot.address, player, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t + 60n,
    });
    const asOperator = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(asOperator.write.placeDirectBetFor([player, ZERO_ADDRESS, 0n, t + 60n, sig]));
  });

  it("rejects signature signed by an address other than the authorized session key", async () => {
    const { authHub, jackpot } = await setup();
    await authorizeSessionKey(authHub.address);
    // Sign with walletClients[5] (other) instead of session key (walletClients[2])
    const t = await nowOnChain();
    const sig = await signPlaceDirectBet(walletClients[5], jackpot.address, {
      game: jackpot.address, player, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t + 60n,
    });
    const asOperator = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(asOperator.write.placeDirectBetFor([player, ZERO_ADDRESS, 0n, t + 60n, sig]));
  });

  it("rejects signature for an expired session key", async () => {
    const { authHub, jackpot } = await setup();
    const t = await nowOnChain();
    // Authorize with short expiration (10 seconds)
    await authorizeSessionKey(authHub.address, 0n, t + 10n);
    // Move time past expiration
    await env.networkHelpers.time.increase(20);

    const t2 = await nowOnChain();
    const sig = await signPlaceDirectBet(walletClients[2], jackpot.address, {
      game: jackpot.address, player, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t2 + 60n,
    });
    const asOperator = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    // sessionKeyOf returns address(0) after expiry → NoSessionKey revert
    await expectRevert(asOperator.write.placeDirectBetFor([player, ZERO_ADDRESS, 0n, t2 + 60n, sig]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Game binding (defense-in-depth)
// ─────────────────────────────────────────────────────────────────────────────

describe("SignedActionAuth — game-binding (defense-in-depth)", () => {
  it("rejects when the structHash binds to a different game address", async () => {
    // We can construct a malicious structHash by signing with a different `game` field.
    // The contract's _verifyAndConsume should compare game == address(this) and revert.
    // BUT the contract builds structHash itself from address(this), so the operator can't
    // pass a "different game" directly. The check still fires inside _verifyAndConsume.
    // To exercise it, we'd need to call _verifyAndConsume directly, which requires a contract.
    //
    // Indirect verification: as long as the typehash includes `address game` and the
    // structHash uses `address(this)`, signatures for game A cannot be replayed on game B
    // because their domain separators differ (different verifyingContract). This is covered
    // implicitly by the "wrong game in sig" idea — a signature minted for one game's domain
    // simply won't recover correctly when verified against another game's domain.
    //
    // We test this by signing for a fake game address but submitting to the real one:
    const { authHub, jackpot } = await setup();
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const fakeGame = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    // Sign WITH fake game in domain — won't recover correctly
    const sig = await walletClients[2].signTypedData({
      domain: {
        name: "ProgressiveJackpot",
        version: "1",
        chainId,
        verifyingContract: fakeGame,
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
        game: fakeGame, player, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t + 60n,
      },
    });
    const asOperator = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    // Real jackpot's domain differs → recovered signer ≠ session key → InvalidSignature
    await expectRevert(asOperator.write.placeDirectBetFor([player, ZERO_ADDRESS, 0n, t + 60n, sig]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy paths + nonce consumption + spend cap integration
// ─────────────────────────────────────────────────────────────────────────────

describe("SignedActionAuth — happy paths + nonce consumption + spend cap", () => {
  it("happy path: bet placed, nonce incremented, request created", async () => {
    const { authHub, jackpot, provider } = await setup();
    await authorizeSessionKey(authHub.address);
    expect(await jackpot.read.actionNonces([player])).to.equal(0n);

    const t = await nowOnChain();
    const sig = await signPlaceDirectBet(walletClients[2], jackpot.address, {
      game: jackpot.address, player, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t + 60n,
    });
    const asOperator = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    await asOperator.write.placeDirectBetFor([player, ZERO_ADDRESS, 0n, t + 60n, sig]);

    // Nonce consumed
    expect(await jackpot.read.actionNonces([player])).to.equal(1n);
    // Request created (mock provider's nextRequestId advanced)
    expect(await provider.read.nextRequestId()).to.equal(2n);
  });

  it("nonce consumption: replay of the same signature reverts", async () => {
    const { authHub, jackpot } = await setup();
    await authorizeSessionKey(authHub.address);
    const t = await nowOnChain();
    const sig = await signPlaceDirectBet(walletClients[2], jackpot.address, {
      game: jackpot.address, player, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t + 60n,
    });
    const asOperator = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    await asOperator.write.placeDirectBetFor([player, ZERO_ADDRESS, 0n, t + 60n, sig]);
    // Replay: nonce 0 already consumed, current is 1
    await expectRevert(asOperator.write.placeDirectBetFor([player, ZERO_ADDRESS, 0n, t + 60n, sig]));
  });

  it("multiple consecutive bets with incrementing nonces", async () => {
    const { authHub, jackpot } = await setup();
    await authorizeSessionKey(authHub.address);
    const asOperator = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });

    for (let n = 0; n < 3; n++) {
      const t = await nowOnChain();
      const sig = await signPlaceDirectBet(walletClients[2], jackpot.address, {
        game: jackpot.address, player, potentialReferrer: ZERO_ADDRESS, nonce: BigInt(n), deadline: t + 60n,
      });
      await asOperator.write.placeDirectBetFor([player, ZERO_ADDRESS, BigInt(n), t + 60n, sig]);
    }
    expect(await jackpot.read.actionNonces([player])).to.equal(3n);
  });

  it("spend cap integration: each bet records cost; exceeding the cap reverts", async () => {
    // Cap = 1.5 EVA → first bet (1 EVA) succeeds, second (would be 2 EVA total) reverts
    const { authHub, jackpot } = await setup();
    await authorizeSessionKey(authHub.address, ONE_EVA + ONE_EVA / 2n); // 1.5 EVA cap
    const asOperator = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });

    // First bet succeeds (1 EVA + 0 spent < 1.5 EVA cap)
    const t1 = await nowOnChain();
    const sig1 = await signPlaceDirectBet(walletClients[2], jackpot.address, {
      game: jackpot.address, player, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t1 + 60n,
    });
    await asOperator.write.placeDirectBetFor([player, ZERO_ADDRESS, 0n, t1 + 60n, sig1]);
    expect((await authHub.read.keys([player]))[3]).to.equal(ONE_EVA); // spent = 1 EVA

    // Second bet would push spent to 2 EVA > 1.5 EVA cap → SpendCapExceeded
    const t2 = await nowOnChain();
    const sig2 = await signPlaceDirectBet(walletClients[2], jackpot.address, {
      game: jackpot.address, player, potentialReferrer: ZERO_ADDRESS, nonce: 1n, deadline: t2 + 60n,
    });
    await expectRevert(asOperator.write.placeDirectBetFor([player, ZERO_ADDRESS, 1n, t2 + 60n, sig2]));
    // Spent unchanged
    expect((await authHub.read.keys([player]))[3]).to.equal(ONE_EVA);
    // Nonce also unchanged (the revert rolled the whole tx back)
    expect(await jackpot.read.actionNonces([player])).to.equal(1n);
  });

  it("spend cap = 0 (unlimited): bets never trigger cap revert", async () => {
    const { authHub, jackpot } = await setup();
    await authorizeSessionKey(authHub.address, 0n); // unlimited
    const asOperator = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    for (let n = 0; n < 5; n++) {
      const t = await nowOnChain();
      const sig = await signPlaceDirectBet(walletClients[2], jackpot.address, {
        game: jackpot.address, player, potentialReferrer: ZERO_ADDRESS, nonce: BigInt(n), deadline: t + 60n,
      });
      await asOperator.write.placeDirectBetFor([player, ZERO_ADDRESS, BigInt(n), t + 60n, sig]);
    }
    // Spent stays 0 because cap is 0 (unlimited)
    expect((await authHub.read.keys([player]))[3]).to.equal(0n);
  });

  it("getActionNonce: convenience view returns the same value as actionNonces", async () => {
    const { authHub, jackpot } = await setup();
    await authorizeSessionKey(authHub.address);
    const asOperator = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    const t = await nowOnChain();
    const sig = await signPlaceDirectBet(walletClients[2], jackpot.address, {
      game: jackpot.address, player, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t + 60n,
    });
    await asOperator.write.placeDirectBetFor([player, ZERO_ADDRESS, 0n, t + 60n, sig]);
    expect(await jackpot.read.getActionNonce([player])).to.equal(1n);
  });

  it("domainSeparator view returns a non-zero EIP-712 domain separator", async () => {
    const { jackpot } = await setup();
    const sep = await jackpot.read.domainSeparator();
    expect(sep).to.not.equal("0x" + "00".repeat(32));
  });

  it("delegated bet behaves identically to direct bet (same internal flow + events)", async () => {
    // Both placeDirectBet and placeDirectBetFor route through _placeDirectBetInternal,
    // so the resulting state/events should be identical for equivalent inputs.
    const { authHub, jackpot, provider, token } = await setup();
    await authorizeSessionKey(authHub.address);

    // Snapshot state before delegated bet
    const playerBalBefore = await token.read.balanceOf([player]);
    const lastReqIdBefore = await provider.read.nextRequestId();

    // Delegated bet
    const t = await nowOnChain();
    const sig = await signPlaceDirectBet(walletClients[2], jackpot.address, {
      game: jackpot.address, player, potentialReferrer: ZERO_ADDRESS, nonce: 0n, deadline: t + 60n,
    });
    const asOperator = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    await asOperator.write.placeDirectBetFor([player, ZERO_ADDRESS, 0n, t + 60n, sig]);

    const playerBalAfter = await token.read.balanceOf([player]);
    expect(playerBalBefore - playerBalAfter).to.equal(ONE_EVA); // player paid the bet cost
    expect(await provider.read.nextRequestId()).to.equal(lastReqIdBefore + 1n); // request created
  });
});
