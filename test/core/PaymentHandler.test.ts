import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";

import { ZERO_ADDRESS, MAX_BPS, ONE_EVA, HUNDRED_EVA, ONE_THOUSAND_EVA } from "../helpers/constants.js";
import { expectRevert } from "../helpers/utils.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

type Env = Awaited<ReturnType<typeof network.connect>>;

let env: Env;
let walletClients: Awaited<ReturnType<Env["viem"]["getWalletClients"]>>;

let deployer: `0x${string}`;
let game: `0x${string}`;          // wallet acting as a registered game (msg.sender of processDirectBetFromGame)
let player: `0x${string}`;
let referrerAddr: `0x${string}`;
let feeRecipient: `0x${string}`;
let defaultRcv: `0x${string}`;
let nonOwner: `0x${string}`;

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  deployer = walletClients[0].account.address;
  game = walletClients[1].account.address;
  player = walletClients[2].account.address;
  referrerAddr = walletClients[3].account.address;
  feeRecipient = walletClients[4].account.address;
  defaultRcv = walletClients[5].account.address;
  nonOwner = walletClients[6].account.address;
});

/// Standard config used in tests: 200 bps house, 200 bps referral, 350 bps jackpot.
const HOUSE_BPS = 200;
const REFERRAL_BPS = 200;
const JACKPOT_BPS = 350;
const NET_BPS = Number(MAX_BPS) - HOUSE_BPS - REFERRAL_BPS - JACKPOT_BPS; // 9250

/// Fresh deployment with no extra wiring (referral/jackpot/games unset).
async function freshHandler() {
  const token = await env.viem.deployContract("EverValueCoin");
  const handler = await env.viem.deployContract("PaymentHandler", [token.address]);
  return { token, handler };
}

/// Fully-wired deployment: real MultiLevelReferral + MockJackpotForHandler + game registered.
/// Game wallet is funded with `ONE_THOUSAND_EVA` and approves the handler for max.
/// MLR has 1 level at 100% bps so referral fees flow to a single referrer cleanly.
async function fullyWiredDeployment() {
  const token = await env.viem.deployContract("EverValueCoin");
  const handler = await env.viem.deployContract("PaymentHandler", [token.address]);

  // Real MLR — already tested independently
  const mlr = await env.viem.deployContract("MultiLevelReferral", [token.address, defaultRcv]);
  await mlr.write.setLevels([1, [10000]]);
  await mlr.write.setPaymentHandler([handler.address]);

  // Mock jackpot
  const jackpot = await env.viem.deployContract("MockJackpotForHandler", [token.address]);

  // Wire references
  await handler.write.setReferralContract([mlr.address]);
  await handler.write.setJackpot([jackpot.address]);

  // Register the game (game wallet is both msg.sender and payoutTarget)
  await handler.write.registerGame([
    game,
    game, // payoutTarget = game itself
    feeRecipient,
    HOUSE_BPS,
    REFERRAL_BPS,
    JACKPOT_BPS,
  ]);

  // Fund the game wallet with EVA
  await token.write.transfer([game, ONE_THOUSAND_EVA]);

  // Game approves handler so processDirectBetFromGame can pull
  const tokenAsGame = await env.viem.getContractAt("EverValueCoin", token.address, {
    client: { wallet: walletClients[1] },
  });
  await tokenAsGame.write.approve([handler.address, ONE_THOUSAND_EVA * 2n]);

  const handlerAsGame = await env.viem.getContractAt("PaymentHandler", handler.address, {
    client: { wallet: walletClients[1] },
  });

  return { token, handler, mlr, jackpot, handlerAsGame };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("PaymentHandler — constructor", () => {
  it("rejects zero token address", async () => {
    await expectRevert(env.viem.deployContract("PaymentHandler", [ZERO_ADDRESS]), "Invalid EVA token");
  });

  it("deploys with valid token; owner is deployer; referral and jackpot start unset", async () => {
    const { token, handler } = await freshHandler();
    expect((await handler.read.evaToken()).toLowerCase()).to.equal(token.address.toLowerCase());
    expect((await handler.read.owner()).toLowerCase()).to.equal(deployer.toLowerCase());
    expect((await handler.read.referralContract()).toLowerCase()).to.equal(ZERO_ADDRESS);
    expect((await handler.read.getJackpot()).toLowerCase()).to.equal(ZERO_ADDRESS);
  });
});

describe("PaymentHandler — setReferralContract", () => {
  it("rejects non-owner caller", async () => {
    const { handler } = await freshHandler();
    const handlerAsOther = await env.viem.getContractAt("PaymentHandler", handler.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(handlerAsOther.write.setReferralContract([nonOwner]), "Ownable");
  });

  it("sets the referral contract address", async () => {
    const { handler } = await freshHandler();
    await handler.write.setReferralContract([referrerAddr]);
    expect((await handler.read.referralContract()).toLowerCase()).to.equal(referrerAddr.toLowerCase());
  });

  it("can clear the reference (set to zero)", async () => {
    const { handler } = await freshHandler();
    await handler.write.setReferralContract([referrerAddr]);
    await handler.write.setReferralContract([ZERO_ADDRESS]);
    expect((await handler.read.referralContract()).toLowerCase()).to.equal(ZERO_ADDRESS);
  });
});

describe("PaymentHandler — setJackpot", () => {
  it("rejects non-owner caller", async () => {
    const { handler } = await freshHandler();
    const handlerAsOther = await env.viem.getContractAt("PaymentHandler", handler.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(handlerAsOther.write.setJackpot([nonOwner]), "Ownable");
  });

  it("sets jackpot, grants max allowance", async () => {
    const { token, handler } = await freshHandler();
    const jackpot = await env.viem.deployContract("MockJackpotForHandler", [token.address]);
    await handler.write.setJackpot([jackpot.address]);
    expect((await handler.read.getJackpot()).toLowerCase()).to.equal(jackpot.address.toLowerCase());
    const allowance = await token.read.allowance([handler.address, jackpot.address]);
    expect(allowance).to.equal(2n ** 256n - 1n);
  });

  it("revokes old jackpot's allowance when replacing", async () => {
    const { token, handler } = await freshHandler();
    const jackpotA = await env.viem.deployContract("MockJackpotForHandler", [token.address]);
    const jackpotB = await env.viem.deployContract("MockJackpotForHandler", [token.address]);

    await handler.write.setJackpot([jackpotA.address]);
    expect(await token.read.allowance([handler.address, jackpotA.address])).to.equal(2n ** 256n - 1n);

    await handler.write.setJackpot([jackpotB.address]);
    expect(await token.read.allowance([handler.address, jackpotA.address])).to.equal(0n);
    expect(await token.read.allowance([handler.address, jackpotB.address])).to.equal(2n ** 256n - 1n);
  });

  it("clearing the jackpot (set to zero) revokes the old allowance and stores zero address", async () => {
    const { token, handler } = await freshHandler();
    const jackpot = await env.viem.deployContract("MockJackpotForHandler", [token.address]);
    await handler.write.setJackpot([jackpot.address]);
    await handler.write.setJackpot([ZERO_ADDRESS]);
    expect((await handler.read.getJackpot()).toLowerCase()).to.equal(ZERO_ADDRESS);
    expect(await token.read.allowance([handler.address, jackpot.address])).to.equal(0n);
  });
});

describe("PaymentHandler — whitelist / blacklist toggles + per-address updates", () => {
  it("setWhitelistEnabled toggles state, owner-only", async () => {
    const { handler } = await freshHandler();
    expect(await handler.read.whitelistEnabled()).to.equal(false);
    await handler.write.setWhitelistEnabled([true]);
    expect(await handler.read.whitelistEnabled()).to.equal(true);

    const handlerAsOther = await env.viem.getContractAt("PaymentHandler", handler.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(handlerAsOther.write.setWhitelistEnabled([false]), "Ownable");
  });

  it("setBlacklistEnabled toggles state, owner-only", async () => {
    const { handler } = await freshHandler();
    expect(await handler.read.blacklistEnabled()).to.equal(false);
    await handler.write.setBlacklistEnabled([true]);
    expect(await handler.read.blacklistEnabled()).to.equal(true);

    const handlerAsOther = await env.viem.getContractAt("PaymentHandler", handler.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(handlerAsOther.write.setBlacklistEnabled([false]), "Ownable");
  });

  it("setWhitelist/setBlacklist updates entries in batch, owner-only", async () => {
    const { handler } = await freshHandler();

    await handler.write.setWhitelist([[player, referrerAddr], true]);
    expect(await handler.read.whitelist([player])).to.equal(true);
    expect(await handler.read.whitelist([referrerAddr])).to.equal(true);

    await handler.write.setWhitelist([[player], false]);
    expect(await handler.read.whitelist([player])).to.equal(false);
    expect(await handler.read.whitelist([referrerAddr])).to.equal(true);

    await handler.write.setBlacklist([[player], true]);
    expect(await handler.read.blacklist([player])).to.equal(true);

    const handlerAsOther = await env.viem.getContractAt("PaymentHandler", handler.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(handlerAsOther.write.setWhitelist([[player], true]), "Ownable");
    await expectRevert(handlerAsOther.write.setBlacklist([[player], false]), "Ownable");
  });
});

describe("PaymentHandler — selfExclude", () => {
  it("marks the caller as self-excluded; cannot exclude twice", async () => {
    const { handler } = await freshHandler();
    const handlerAsPlayer = await env.viem.getContractAt("PaymentHandler", handler.address, {
      client: { wallet: walletClients[2] },
    });
    expect(await handler.read.selfExcluded([player])).to.equal(false);
    await handlerAsPlayer.write.selfExclude();
    expect(await handler.read.selfExcluded([player])).to.equal(true);
    // Second call must revert. (Hardhat's EDR doesn't always surface the require message
    // for this code path; verifying the revert itself is what matters here.)
    await expectRevert(handlerAsPlayer.write.selfExclude());
  });
});

describe("PaymentHandler — registerGame", () => {
  it("rejects non-owner caller", async () => {
    const { handler } = await freshHandler();
    const handlerAsOther = await env.viem.getContractAt("PaymentHandler", handler.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(
      handlerAsOther.write.registerGame([game, game, feeRecipient, HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS]),
      "Ownable",
    );
  });

  it("rejects zero game address", async () => {
    const { handler } = await freshHandler();
    await expectRevert(
      handler.write.registerGame([ZERO_ADDRESS, game, feeRecipient, HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS]),
      "Invalid game",
    );
  });

  it("rejects zero payoutTarget", async () => {
    const { handler } = await freshHandler();
    await expectRevert(
      handler.write.registerGame([game, ZERO_ADDRESS, feeRecipient, HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS]),
      "Invalid payout target",
    );
  });

  it("rejects total bps > MAX_BPS", async () => {
    const { handler } = await freshHandler();
    await expectRevert(
      handler.write.registerGame([game, game, feeRecipient, 5000, 4000, 2000]),
      "Bps overflow",
    );
  });

  it("rejects re-registration of the same game", async () => {
    const { handler } = await freshHandler();
    await handler.write.registerGame([game, game, feeRecipient, HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS]);
    await expectRevert(
      handler.write.registerGame([game, game, feeRecipient, HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS]),
      "Game already registered",
    );
  });

  it("registers the game and stores the full config", async () => {
    const { handler } = await freshHandler();
    await handler.write.registerGame([game, game, feeRecipient, HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS]);
    const cfg = await handler.read.getGameConfig([game]);
    expect(cfg[0]).to.equal(true); // enabled
    expect(cfg[1].toLowerCase()).to.equal(game.toLowerCase()); // payoutTarget
    expect(cfg[2].toLowerCase()).to.equal(feeRecipient.toLowerCase()); // feeRecipient
    expect(cfg[3]).to.equal(HOUSE_BPS);
    expect(cfg[4]).to.equal(REFERRAL_BPS);
    expect(cfg[5]).to.equal(JACKPOT_BPS);
  });
});

describe("PaymentHandler — updateGameConfig (incl. bug #5 zero-payoutTarget validation)", () => {
  it("rejects non-owner caller", async () => {
    const { handler } = await freshHandler();
    await handler.write.registerGame([game, game, feeRecipient, HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS]);
    const handlerAsOther = await env.viem.getContractAt("PaymentHandler", handler.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(
      handlerAsOther.write.updateGameConfig([game, game, feeRecipient, 100, 100, 100]),
      "Ownable",
    );
  });

  it("rejects zero payoutTarget (bug #5 fix)", async () => {
    const { handler } = await freshHandler();
    await handler.write.registerGame([game, game, feeRecipient, HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS]);
    await expectRevert(
      handler.write.updateGameConfig([game, ZERO_ADDRESS, feeRecipient, HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS]),
      "Invalid payout target",
    );
  });

  it("rejects total bps > MAX_BPS", async () => {
    const { handler } = await freshHandler();
    await handler.write.registerGame([game, game, feeRecipient, HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS]);
    await expectRevert(
      handler.write.updateGameConfig([game, game, feeRecipient, 9000, 1000, 1]),
      "Bps overflow",
    );
  });

  it("rejects update of unregistered game", async () => {
    const { handler } = await freshHandler();
    await expectRevert(
      handler.write.updateGameConfig([game, game, feeRecipient, 100, 100, 100]),
      "Game not registered",
    );
  });

  it("updates fields in place", async () => {
    const { handler } = await freshHandler();
    await handler.write.registerGame([game, game, feeRecipient, HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS]);
    await handler.write.updateGameConfig([game, player, defaultRcv, 100, 200, 300]);
    const cfg = await handler.read.getGameConfig([game]);
    expect(cfg[1].toLowerCase()).to.equal(player.toLowerCase()); // payoutTarget changed
    expect(cfg[2].toLowerCase()).to.equal(defaultRcv.toLowerCase()); // feeRecipient changed
    expect(cfg[3]).to.equal(100);
    expect(cfg[4]).to.equal(200);
    expect(cfg[5]).to.equal(300);
  });
});

describe("PaymentHandler — setGameStatus", () => {
  it("rejects non-owner caller", async () => {
    const { handler } = await freshHandler();
    await handler.write.registerGame([game, game, feeRecipient, HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS]);
    const handlerAsOther = await env.viem.getContractAt("PaymentHandler", handler.address, {
      client: { wallet: walletClients[6] },
    });
    await expectRevert(handlerAsOther.write.setGameStatus([game, false]), "Ownable");
  });

  it("rejects unregistered game", async () => {
    const { handler } = await freshHandler();
    await expectRevert(handler.write.setGameStatus([game, false]), "Game not registered");
  });

  it("toggles enabled flag", async () => {
    const { handler } = await freshHandler();
    await handler.write.registerGame([game, game, feeRecipient, HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS]);
    await handler.write.setGameStatus([game, false]);
    const cfg = await handler.read.getGameConfig([game]);
    expect(cfg[0]).to.equal(false);
  });
});

describe("PaymentHandler — view helpers (getTotalDeductionBps / getNetStakeBps)", () => {
  it("getTotalDeductionBps returns sum of houseEdge + referral + jackpot bps", async () => {
    const { handler } = await freshHandler();
    await handler.write.registerGame([game, game, feeRecipient, HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS]);
    const total = await handler.read.getTotalDeductionBps([game]);
    expect(total).to.equal(HOUSE_BPS + REFERRAL_BPS + JACKPOT_BPS);
  });

  it("getNetStakeBps returns MAX_BPS - getTotalDeductionBps", async () => {
    const { handler } = await freshHandler();
    await handler.write.registerGame([game, game, feeRecipient, HOUSE_BPS, REFERRAL_BPS, JACKPOT_BPS]);
    const net = await handler.read.getNetStakeBps([game]);
    expect(net).to.equal(NET_BPS);
  });
});

describe("PaymentHandler — processDirectBetFromGame access control", () => {
  it("rejects call from unregistered msg.sender", async () => {
    const { handler } = await freshHandler();
    const handlerAsGame = await env.viem.getContractAt("PaymentHandler", handler.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(
      handlerAsGame.write.processDirectBetFromGame([player, ZERO_ADDRESS, ONE_EVA]),
      "Game not registered",
    );
  });

  it("rejects when game is disabled", async () => {
    const { handlerAsGame, handler } = await fullyWiredDeployment();
    await handler.write.setGameStatus([game, false]);
    await expectRevert(
      handlerAsGame.write.processDirectBetFromGame([player, ZERO_ADDRESS, ONE_EVA]),
      "Game disabled",
    );
  });

  it("rejects baseCost = 0", async () => {
    const { handlerAsGame } = await fullyWiredDeployment();
    await expectRevert(
      handlerAsGame.write.processDirectBetFromGame([player, ZERO_ADDRESS, 0n]),
      "Amount must be positive",
    );
  });

  it("rejects self-excluded bettor", async () => {
    const { handler, handlerAsGame } = await fullyWiredDeployment();
    const handlerAsPlayer = await env.viem.getContractAt("PaymentHandler", handler.address, {
      client: { wallet: walletClients[2] },
    });
    await handlerAsPlayer.write.selfExclude();
    await expectRevert(
      handlerAsGame.write.processDirectBetFromGame([player, ZERO_ADDRESS, ONE_EVA]),
      "Self-excluded",
    );
  });

  it("rejects bettor when blacklist is enabled and they are blacklisted", async () => {
    const { handler, handlerAsGame } = await fullyWiredDeployment();
    await handler.write.setBlacklistEnabled([true]);
    await handler.write.setBlacklist([[player], true]);
    await expectRevert(
      handlerAsGame.write.processDirectBetFromGame([player, ZERO_ADDRESS, ONE_EVA]),
      "Blacklisted",
    );
  });

  it("rejects bettor when whitelist is enabled and they are not whitelisted", async () => {
    const { handler, handlerAsGame } = await fullyWiredDeployment();
    await handler.write.setWhitelistEnabled([true]);
    await expectRevert(
      handlerAsGame.write.processDirectBetFromGame([player, ZERO_ADDRESS, ONE_EVA]),
      "Not whitelisted",
    );
  });
});

describe("PaymentHandler — processDirectBetFromGame core flow", () => {
  it("slices baseCost into house/referral/jackpot/net and routes each correctly", async () => {
    const { token, handler, mlr, jackpot, handlerAsGame } = await fullyWiredDeployment();

    const baseCost = HUNDRED_EVA;
    const expectedHouse = (baseCost * BigInt(HOUSE_BPS)) / MAX_BPS;
    const expectedReferral = (baseCost * BigInt(REFERRAL_BPS)) / MAX_BPS;
    const expectedJackpot = (baseCost * BigInt(JACKPOT_BPS)) / MAX_BPS;
    const expectedNet = baseCost - expectedHouse - expectedReferral - expectedJackpot;

    const feeRecipientBefore = await token.read.balanceOf([feeRecipient]);
    const gameBefore = await token.read.balanceOf([game]);

    await handlerAsGame.write.processDirectBetFromGame([player, referrerAddr, baseCost]);

    // Fee recipient got houseFee
    expect((await token.read.balanceOf([feeRecipient])) - feeRecipientBefore).to.equal(expectedHouse);

    // Jackpot mock pulled the jackpotShare via addFunds
    expect(await jackpot.read.totalReceived()).to.equal(expectedJackpot);
    expect(await jackpot.read.callCount()).to.equal(1n);
    expect(await jackpot.read.lastAmount()).to.equal(expectedJackpot);

    // Referral contract recorded the credit; MLR has 1 level @ 10000 bps so all flows to bob
    expect(await mlr.read.pendingRewards([referrerAddr])).to.equal(expectedReferral);
    expect(await mlr.read.totalPendingRewards()).to.equal(expectedReferral);
    // Player's referrer got assigned
    expect((await mlr.read.referrerOf([player])).toLowerCase()).to.equal(referrerAddr.toLowerCase());

    // Game wallet net change = -baseCost (sent to handler) + netAmount (received back)
    const gameAfter = await token.read.balanceOf([game]);
    expect(gameBefore - gameAfter).to.equal(baseCost - expectedNet);

    // Handler holds nothing afterwards
    expect(await token.read.balanceOf([handler.address])).to.equal(0n);
  });

  it("rejects when houseEdgeBps > 0 but feeRecipient is zero", async () => {
    const { token, handler } = await freshHandler();

    // register a game with houseEdge > 0 but feeRecipient = 0
    await handler.write.registerGame([game, game, ZERO_ADDRESS, HOUSE_BPS, 0, 0]);

    // setup so the call reaches the feeRecipient check
    await token.write.transfer([game, HUNDRED_EVA]);
    const tokenAsGame = await env.viem.getContractAt("EverValueCoin", token.address, {
      client: { wallet: walletClients[1] },
    });
    await tokenAsGame.write.approve([handler.address, HUNDRED_EVA]);

    const handlerAsGame = await env.viem.getContractAt("PaymentHandler", handler.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(
      handlerAsGame.write.processDirectBetFromGame([player, ZERO_ADDRESS, ONE_EVA]),
      "Fee recipient not set",
    );
  });

  it("rejects when referralBps > 0 but referralContract is unset", async () => {
    const { token, handler } = await freshHandler();
    await handler.write.registerGame([game, game, feeRecipient, 0, REFERRAL_BPS, 0]);
    // referralContract NOT set

    await token.write.transfer([game, HUNDRED_EVA]);
    const tokenAsGame = await env.viem.getContractAt("EverValueCoin", token.address, {
      client: { wallet: walletClients[1] },
    });
    await tokenAsGame.write.approve([handler.address, HUNDRED_EVA]);
    const handlerAsGame = await env.viem.getContractAt("PaymentHandler", handler.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(
      handlerAsGame.write.processDirectBetFromGame([player, referrerAddr, ONE_EVA]),
      "Referral contract not set",
    );
  });

  it("rejects when jackpotBps > 0 but jackpot is unset", async () => {
    const { token, handler } = await freshHandler();
    await handler.write.registerGame([game, game, feeRecipient, 0, 0, JACKPOT_BPS]);
    // jackpot NOT set

    await token.write.transfer([game, HUNDRED_EVA]);
    const tokenAsGame = await env.viem.getContractAt("EverValueCoin", token.address, {
      client: { wallet: walletClients[1] },
    });
    await tokenAsGame.write.approve([handler.address, HUNDRED_EVA]);
    const handlerAsGame = await env.viem.getContractAt("PaymentHandler", handler.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(
      handlerAsGame.write.processDirectBetFromGame([player, ZERO_ADDRESS, ONE_EVA]),
      "Jackpot not set",
    );
  });

  it("works when all bps are zero: full baseCost goes to game; no referral, no jackpot calls", async () => {
    const { token, handler } = await freshHandler();
    await handler.write.registerGame([game, game, feeRecipient, 0, 0, 0]);

    await token.write.transfer([game, HUNDRED_EVA]);
    const tokenAsGame = await env.viem.getContractAt("EverValueCoin", token.address, {
      client: { wallet: walletClients[1] },
    });
    await tokenAsGame.write.approve([handler.address, HUNDRED_EVA]);

    const handlerAsGame = await env.viem.getContractAt("PaymentHandler", handler.address, {
      client: { wallet: walletClients[1] },
    });
    const before = await token.read.balanceOf([game]);
    await handlerAsGame.write.processDirectBetFromGame([player, referrerAddr, ONE_EVA]);
    const after = await token.read.balanceOf([game]);
    // game spent ONE_EVA and got ONE_EVA back as netAmount → no net change
    expect(after).to.equal(before);
  });

  it("bug #1 fix: getReferrer is NOT called when referralContract is unset (no revert)", async () => {
    // Set up: jackpotBps=0, referralBps=0, houseEdgeBps>0; no referralContract.
    // The pre-fix code would have called getReferrer(bettor) on address(0) and reverted.
    const { token, handler } = await freshHandler();
    await handler.write.registerGame([game, game, feeRecipient, HOUSE_BPS, 0, 0]);

    await token.write.transfer([game, HUNDRED_EVA]);
    const tokenAsGame = await env.viem.getContractAt("EverValueCoin", token.address, {
      client: { wallet: walletClients[1] },
    });
    await tokenAsGame.write.approve([handler.address, HUNDRED_EVA]);
    const handlerAsGame = await env.viem.getContractAt("PaymentHandler", handler.address, {
      client: { wallet: walletClients[1] },
    });

    // Should succeed cleanly even though referralContract == address(0)
    await handlerAsGame.write.processDirectBetFromGame([player, referrerAddr, ONE_EVA]);
  });

  it("rejects when netAmount would be zero (all bps sum to MAX_BPS)", async () => {
    const { token, handler } = await freshHandler();
    // 100% deduction (5000+5000) ⇒ netAmount = 0
    await handler.write.registerGame([game, game, feeRecipient, 5000, 5000, 0]);
    await handler.write.setReferralContract([referrerAddr]); // not zero, just so we get past the fee-recipient check

    await token.write.transfer([game, HUNDRED_EVA]);
    const tokenAsGame = await env.viem.getContractAt("EverValueCoin", token.address, {
      client: { wallet: walletClients[1] },
    });
    await tokenAsGame.write.approve([handler.address, HUNDRED_EVA]);
    const handlerAsGame = await env.viem.getContractAt("PaymentHandler", handler.address, {
      client: { wallet: walletClients[1] },
    });

    await expectRevert(
      handlerAsGame.write.processDirectBetFromGame([player, referrerAddr, ONE_EVA]),
      "Net amount zero",
    );
  });
});
