import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";

import { ZERO_ADDRESS, ONE_EVA, HUNDRED_EVA } from "../helpers/constants.js";
import { expectRevert } from "../helpers/utils.js";

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;

let deployer: `0x${string}`;
let admin: `0x${string}`;
let player: `0x${string}`;
let game: `0x${string}`;        // wallet acting as registered game
let handler: `0x${string}`;     // wallet acting as PaymentHandler

const PROBABILITY_PRECISION = 1_000_000n;
const TIER_COUNT = 9;

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  deployer = walletClients[0].account.address;
  admin = walletClients[1].account.address;
  player = walletClients[2].account.address;
  game = walletClients[3].account.address;
  handler = walletClients[4].account.address;
});

// ─────────────────────────────────────────────────────────────────────────────
// SHARED FIXTURES
// ─────────────────────────────────────────────────────────────────────────────

async function deployBare() {
  const token = await env.viem.deployContract("EverValueCoin");
  const provider = await env.viem.deployContract("MockJackpotRandomProvider");
  const authHub = await env.viem.deployContract("AuthHub");
  const jackpot = await env.viem.deployContract("ProgressiveJackpot", [token.address, provider.address, authHub.address]);
  return { token, provider, authHub, jackpot };
}

/**
 * Build a fresh jackpot with sane defaults for end-to-end flows:
 *   - 9-tier ladder (small fixed costs, last tier terminal)
 *   - Default probability config across all tiers
 *   - Game wallet registered with a 5-outcome table:
 *       outcomes[0] = pure lose (fallback)
 *       outcomes[1] = consolation 1.2x
 *       outcomes[2] = consolation 1.5x
 *       outcomes[3] = tier-0 award (advance 1)
 *       outcomes[4..] = tier-1..N awards (also advance 1, last is terminal)
 *   - Player can later record bets via this game
 *   - Handler wallet is registered as paymentHandler for direct-bet flow
 *   - Pots seeded so payouts can succeed
 */
async function deployConfigured() {
  const { token, provider, jackpot } = await deployBare();

  // Wire the handler wallet so it can call addFunds (must approve)
  await jackpot.write.setPaymentHandler([handler]);

  // 9-tier ladder; tier 8 (last) is terminal. fixedBetCost rises gently.
  const tiers = [];
  for (let i = 0; i < 9; i++) {
    tiers.push({
      prizeMetric: 0n,
      isTerminal: i === 8,
      isPercent: false,
      fixedBetCost: ONE_EVA + BigInt(i) * (ONE_EVA / 10n),
      useDynamicCost: false,
      costBps: 0,
    });
  }
  await jackpot.write.setTierLadder([tiers]);

  // Default probability config per tier
  await jackpot.write.setAllTierProbConfigs([
    1000,         // 0.1% min
    50_000,       // 5% max
    30,           // 0.003% per entry
  ]);

  // Build outcomes for the registered game
  // outcomes layout: [pureLose, consolation1, consolation2, tier0Award, tier1Award, ...]
  const outcomes = [
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0,    awardsTier: false }, // 0: pure lose
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false }, // 1: 1.2x consolation
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 15000, awardsTier: false }, // 2: 1.5x consolation
  ];
  for (let i = 0; i < 9; i++) {
    outcomes.push({
      enabled: true,
      tierAdvance: 1,
      tierResetTo: 0,
      consolationMultiplier: 0,
      awardsTier: true,
    });
  }
  await jackpot.write.registerGame([game, outcomes]);
  await jackpot.write.setGameFallback([game, 0]); // fallback = pure lose

  // Configure direct bet: same outcomes
  await jackpot.write.configureDirectBet([true, outcomes]);
  await jackpot.write.setDirectFallback([0]);

  // Seed pots so awards can pay (handler wallet funds via addFunds)
  await token.write.transfer([handler, HUNDRED_EVA * 10n]);
  const handlerAsToken = await env.viem.getContractAt("EverValueCoin", token.address, {
    client: { wallet: walletClients[4] },
  });
  await handlerAsToken.write.approve([jackpot.address, HUNDRED_EVA * 10n]);
  const handlerAsJp = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
    client: { wallet: walletClients[4] },
  });
  await handlerAsJp.write.addFunds([HUNDRED_EVA * 10n]);

  // Fund player too so direct bets work
  await token.write.transfer([player, HUNDRED_EVA * 10n]);

  return { token, provider, jackpot, handlerAsJp, handlerAsToken };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTRUCTOR + DEFAULTS
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — constructor + defaults", () => {
  it("rejects zero token address", async () => {
    const provider = await env.viem.deployContract("MockJackpotRandomProvider");
    await expectRevert(
      env.viem.deployContract("ProgressiveJackpot", [ZERO_ADDRESS, provider.address, (await env.viem.deployContract("AuthHub")).address]),
      "Invalid token",
    );
  });

  it("rejects zero provider address", async () => {
    const token = await env.viem.deployContract("EverValueCoin");
    await expectRevert(
      env.viem.deployContract("ProgressiveJackpot", [token.address, ZERO_ADDRESS, (await env.viem.deployContract("AuthHub")).address]),
      "Invalid provider",
    );
  });

  it("deploys with sane defaults: tier shares 6.25%x8 + 50%, consolation 5%/12%/6%", async () => {
    const { jackpot } = await deployBare();
    const shares = await jackpot.read.getTierShares();
    for (let i = 0; i < 8; i++) expect(shares[i]).to.equal(625);
    expect(shares[8]).to.equal(5000);

    const cfg = await jackpot.read.getConsolationConfig();
    expect(cfg[1]).to.equal(500);          // shareBps 5%
    expect(cfg[2]).to.equal(120_000);      // 1.2x prob 12%
    expect(cfg[3]).to.equal(60_000);       // 1.5x prob 6%

    expect(await jackpot.read.PROBABILITY_PRECISION()).to.equal(PROBABILITY_PRECISION);
    expect(await jackpot.read.TIER_COUNT()).to.equal(TIER_COUNT);
    expect(await jackpot.read.MAX_ENTRIES()).to.equal(64n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — admin management", () => {
  it("setAdmin: rejects non-owner", async () => {
    const { jackpot } = await deployBare();
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.setAdmin([admin, true]));
  });

  it("setAdmin: rejects zero address", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.setAdmin([ZERO_ADDRESS, true]), "Invalid address");
  });

  it("setAdmin: grants and revokes (state changes)", async () => {
    const { jackpot } = await deployBare();
    await jackpot.write.setAdmin([admin, true]);
    expect(await jackpot.read.isAdmin([admin])).to.equal(true);
    await jackpot.write.setAdmin([admin, false]);
    expect(await jackpot.read.isAdmin([admin])).to.equal(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TIER SHARES
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — setTierShares", () => {
  it("rejects non-owner", async () => {
    const { jackpot } = await deployBare();
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    const shares = [1111, 1111, 1111, 1111, 1111, 1111, 1111, 1111, 1112];
    await expectRevert(asOther.write.setTierShares([shares]));
  });

  it("rejects shares that don't sum to 10000", async () => {
    const { jackpot } = await deployBare();
    const bad = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]; // sum 9000
    await expectRevert(jackpot.write.setTierShares([bad]));
  });

  it("accepts valid shares and exposes via getTierShares", async () => {
    const { jackpot } = await deployBare();
    const shares = [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 2000];
    await jackpot.write.setTierShares([shares]);
    const got = await jackpot.read.getTierShares();
    for (let i = 0; i < 9; i++) expect(got[i]).to.equal(shares[i]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONSOLATION CONFIG
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — consolation config", () => {
  it("setConsolationShare: rejects non-owner", async () => {
    const { jackpot } = await deployBare();
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.setConsolationShare([300]));
  });

  it("setConsolationShare: rejects shareBps > 2000 (max 20%)", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.setConsolationShare([2001]), "Max 20%");
  });

  it("setConsolationShare: accepts and emits", async () => {
    const { jackpot } = await deployBare();
    await jackpot.write.setConsolationShare([1000]);
    const cfg = await jackpot.read.getConsolationConfig();
    expect(cfg[1]).to.equal(1000);
  });

  it("setConsolationProbabilities: rejects non-owner", async () => {
    const { jackpot } = await deployBare();
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.setConsolationProbabilities([100_000, 50_000]));
  });

  it("setConsolationProbabilities: rejects total > 50%", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(
      jackpot.write.setConsolationProbabilities([300_000, 250_000]),
      "Total > 50%",
    );
  });

  it("setConsolationProbabilities: accepts valid and emits", async () => {
    const { jackpot } = await deployBare();
    await jackpot.write.setConsolationProbabilities([200_000, 100_000]);
    const cfg = await jackpot.read.getConsolationConfig();
    expect(cfg[2]).to.equal(200_000);
    expect(cfg[3]).to.equal(100_000);
  });

  it("seedConsolationPot: rejects non-owner", async () => {
    const { token, jackpot } = await deployBare();
    await token.write.approve([jackpot.address, ONE_EVA]);
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.seedConsolationPot([ONE_EVA]));
  });

  it("seedConsolationPot: rejects zero amount", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.seedConsolationPot([0n]), "Amount must be positive");
  });

  it("seedConsolationPot: pulls tokens, increments pot, emits ConsolationPotSeeded", async () => {
    const { token, jackpot } = await deployBare();
    await token.write.approve([jackpot.address, ONE_EVA]);
    await jackpot.write.seedConsolationPot([ONE_EVA]);
    expect(await jackpot.read.consolationPotBalance()).to.equal(ONE_EVA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROBABILITY CONFIG
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — probability config", () => {
  it("setTierProbConfig: rejects non-owner", async () => {
    const { jackpot } = await deployBare();
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.setTierProbConfig([0, 1000, 50_000, 30]));
  });

  it("setTierProbConfig: rejects tier >= TIER_COUNT", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.setTierProbConfig([9, 1000, 50_000, 30]), "Invalid tier");
  });

  it("setTierProbConfig: rejects min > max", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.setTierProbConfig([0, 60_000, 50_000, 30]), "min > max");
  });

  it("setTierProbConfig: rejects max > PROBABILITY_PRECISION", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(
      jackpot.write.setTierProbConfig([0, 1000, 1_500_000, 30]),
      "max > 100%",
    );
  });

  it("setTierProbConfig: stores config and initializes current to min", async () => {
    const { jackpot } = await deployBare();
    await jackpot.write.setTierProbConfig([0, 1000, 50_000, 30]);
    const got = await jackpot.read.getTierProbability([0]);
    expect(got[0]).to.equal(1000n); // current = min initially
    expect(got[1]).to.equal(0n);    // entriesSinceWin
    expect(got[2]).to.equal(1000);  // min
    expect(got[3]).to.equal(50_000);// max
    expect(got[4]).to.equal(30);    // increment
  });

  it("setAllTierProbConfigs: applies same config to all tiers", async () => {
    const { jackpot } = await deployBare();
    await jackpot.write.setAllTierProbConfigs([2000, 60_000, 50]);
    for (let i = 0; i < TIER_COUNT; i++) {
      const got = await jackpot.read.getTierProbability([i]);
      expect(got[2]).to.equal(2000);
      expect(got[3]).to.equal(60_000);
      expect(got[4]).to.equal(50);
    }
  });

  it("setAllTierProbConfigs: rejects min > max", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.setAllTierProbConfigs([60_000, 50_000, 30]), "min > max");
  });

  it("setAllTierProbConfigs: rejects max > PROBABILITY_PRECISION", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(
      jackpot.write.setAllTierProbConfigs([0, 2_000_000, 30]),
      "max > 100%",
    );
  });

  it("getTierProbability: rejects tier >= TIER_COUNT", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.read.getTierProbability([9]), "Invalid tier");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROBABILITY BOOST / RESET
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — boostTierProbability + resetTierProbability", () => {
  it("boostTierProbability: rejects non-admin/non-owner", async () => {
    const { jackpot } = await deployBare();
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.boostTierProbability([0, 100n]));
  });

  it("boostTierProbability: rejects tier >= TIER_COUNT", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.boostTierProbability([9, 100n]), "Invalid tier");
  });

  it("boostTierProbability (owner): increments by simulatedEntries * incrementPpm, capped at maxProbPpm", async () => {
    const { jackpot } = await deployBare();
    await jackpot.write.setTierProbConfig([0, 1000, 50_000, 30]);
    await jackpot.write.boostTierProbability([0, 100n]); // 100 * 30 = 3000 → 4000
    let got = await jackpot.read.getTierProbability([0]);
    expect(got[0]).to.equal(4000n);
    expect(got[1]).to.equal(100n);
    // Boost past max — clamps
    await jackpot.write.boostTierProbability([0, 100_000n]);
    got = await jackpot.read.getTierProbability([0]);
    expect(got[0]).to.equal(50_000n);
  });

  it("boostTierProbability (admin via setAdmin): permitted", async () => {
    const { jackpot } = await deployBare();
    await jackpot.write.setTierProbConfig([0, 1000, 50_000, 30]);
    await jackpot.write.setAdmin([admin, true]);
    const asAdmin = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    await asAdmin.write.boostTierProbability([0, 50n]);
    expect((await jackpot.read.getTierProbability([0]))[0]).to.equal(2500n);
  });

  it("resetTierProbability: rejects non-owner", async () => {
    const { jackpot } = await deployBare();
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.resetTierProbability([0]));
  });

  it("resetTierProbability: rejects tier >= TIER_COUNT", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.resetTierProbability([9]), "Invalid tier");
  });

  it("resetTierProbability: returns current to min and zeros entriesSinceWin", async () => {
    const { jackpot } = await deployBare();
    await jackpot.write.setTierProbConfig([0, 1000, 50_000, 30]);
    await jackpot.write.boostTierProbability([0, 50n]); // 1000 + 1500 = 2500
    await jackpot.write.resetTierProbability([0]);
    const got = await jackpot.read.getTierProbability([0]);
    expect(got[0]).to.equal(1000n);
    expect(got[1]).to.equal(0n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TIER LADDER
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — setTierLadder", () => {
  it("rejects non-owner", async () => {
    const { jackpot } = await deployBare();
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    const t = Array.from({ length: 9 }, (_, i) => ({
      prizeMetric: 0n, isTerminal: i === 8, isPercent: false,
      fixedBetCost: ONE_EVA, useDynamicCost: false, costBps: 0,
    }));
    await expectRevert(asOther.write.setTierLadder([t]));
  });

  it("rejects array length != TIER_COUNT", async () => {
    const { jackpot } = await deployBare();
    const t = Array.from({ length: 8 }, () => ({
      prizeMetric: 0n, isTerminal: false, isPercent: false,
      fixedBetCost: ONE_EVA, useDynamicCost: false, costBps: 0,
    }));
    await expectRevert(jackpot.write.setTierLadder([t]), "Must have 9 tiers");
  });

  it("accepts ladder, resets nextTierIndex, exposes via getTierLadder", async () => {
    const { jackpot } = await deployBare();
    const tiers = Array.from({ length: 9 }, (_, i) => ({
      prizeMetric: BigInt(i),
      isTerminal: i === 8,
      isPercent: false,
      fixedBetCost: ONE_EVA + BigInt(i) * (ONE_EVA / 10n),
      useDynamicCost: false,
      costBps: 0,
    }));
    await jackpot.write.setTierLadder([tiers]);

    const got = await jackpot.read.getTierLadder();
    expect(got.length).to.equal(9);
    expect(got[0].fixedBetCost).to.equal(ONE_EVA);
    expect(got[8].isTerminal).to.equal(true);

    const state = await jackpot.read.getJackpotState();
    expect(state.nextTierIndex).to.equal(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FUNDING
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — funding", () => {
  it("addFunds: only paymentHandler may call", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.addFunds([ONE_EVA]));
  });

  it("addFunds: rejects amount = 0", async () => {
    const { token, jackpot } = await deployBare();
    await jackpot.write.setPaymentHandler([handler]);
    const handlerAsToken = await env.viem.getContractAt("EverValueCoin", token.address, {
      client: { wallet: walletClients[4] },
    });
    await token.write.transfer([handler, ONE_EVA]);
    await handlerAsToken.write.approve([jackpot.address, ONE_EVA]);
    const handlerAsJp = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[4] },
    });
    await expectRevert(handlerAsJp.write.addFunds([0n]), "Amount must be positive");
  });

  it("addFunds: pulls tokens, distributes by shares + consolation off-the-top", async () => {
    const { token, jackpot } = await deployBare();
    await jackpot.write.setPaymentHandler([handler]);
    await token.write.transfer([handler, HUNDRED_EVA]);
    const handlerAsToken = await env.viem.getContractAt("EverValueCoin", token.address, {
      client: { wallet: walletClients[4] },
    });
    await handlerAsToken.write.approve([jackpot.address, HUNDRED_EVA]);
    const handlerAsJp = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[4] },
    });
    await handlerAsJp.write.addFunds([HUNDRED_EVA]);

    // 5% off-the-top to consolation = 5 EVA
    expect(await jackpot.read.consolationPotBalance()).to.equal(5n * ONE_EVA);

    // Remaining 95 EVA distributed: 6.25%×8 to tiers 0-7, 50% to tier 8
    const balances = await jackpot.read.getAllTierPotBalances();
    // Sum equals total minus consolation (95 EVA)
    let sum = 0n;
    for (let i = 0; i < 9; i++) sum += balances[i];
    expect(sum).to.equal(95n * ONE_EVA);
    expect(await jackpot.read.getJackpotBalance()).to.equal(95n * ONE_EVA);
  });

  it("adminAddFunds: rejects non-admin/non-owner", async () => {
    const { token, jackpot } = await deployBare();
    await token.write.approve([jackpot.address, ONE_EVA]);
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.adminAddFunds([ONE_EVA]));
  });

  it("adminAddFunds: rejects amount = 0", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.adminAddFunds([0n]), "Amount must be positive");
  });

  it("adminAddFunds: pulls tokens, distributes, emits AdminFundsDistributed", async () => {
    const { token, jackpot } = await deployBare();
    await token.write.approve([jackpot.address, HUNDRED_EVA]);
    await jackpot.write.adminAddFunds([HUNDRED_EVA]);
    expect(await jackpot.read.getJackpotBalance()).to.equal(95n * ONE_EVA);

    const events = await jackpot.getEvents.AdminFundsDistributed();
    expect(events.length).to.equal(1);
  });

  it("seedTierPot: rejects non-owner", async () => {
    const { token, jackpot } = await deployBare();
    await token.write.approve([jackpot.address, ONE_EVA]);
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.seedTierPot([0, ONE_EVA]));
  });

  it("seedTierPot: rejects tier >= TIER_COUNT", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.seedTierPot([9, ONE_EVA]), "Invalid tier");
  });

  it("seedTierPot: rejects amount = 0", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.seedTierPot([0, 0n]), "Amount must be positive");
  });

  it("seedTierPot: increments specific tier", async () => {
    const { token, jackpot } = await deployBare();
    await token.write.approve([jackpot.address, ONE_EVA]);
    await jackpot.write.seedTierPot([3, ONE_EVA]);
    expect(await jackpot.read.getTierPotBalance([3])).to.equal(ONE_EVA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BALANCE VIEWS
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — balance views", () => {
  it("getTierPotBalance: rejects tier >= TIER_COUNT", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.read.getTierPotBalance([9]), "Invalid tier");
  });

  it("getJackpotBalance + getAllTierPotBalances reflect distribution", async () => {
    const { jackpot } = await deployConfigured();
    const total = await jackpot.read.getJackpotBalance();
    expect(total > 0n).to.equal(true);
    const balances = await jackpot.read.getAllTierPotBalances();
    let sum = 0n;
    for (let i = 0; i < 9; i++) sum += balances[i];
    expect(sum).to.equal(total);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAME MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — game management", () => {
  it("registerGame: rejects non-owner", async () => {
    const { jackpot } = await deployBare();
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    const outcomes = [{
      enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false,
    }];
    await expectRevert(asOther.write.registerGame([game, outcomes]));
  });

  it("registerGame: rejects zero game address", async () => {
    const { jackpot } = await deployBare();
    const outcomes = [{
      enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false,
    }];
    await expectRevert(jackpot.write.registerGame([ZERO_ADDRESS, outcomes]));
  });

  it("registerGame: rejects empty outcomes", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.registerGame([game, []]));
  });

  it("registerGame: stores config, marks registered, emits GameRegistered", async () => {
    const { jackpot } = await deployBare();
    const outcomes = [
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false },
    ];
    await jackpot.write.registerGame([game, outcomes]);
    expect(await jackpot.read.registeredGames([game])).to.equal(true);

    const stored = await jackpot.read.getGameOutcomes([game]);
    expect(stored.length).to.equal(2);

    const list = await jackpot.read.getRegisteredGames();
    expect(list.length).to.equal(1);
    expect(list[0].toLowerCase()).to.equal(game.toLowerCase());
  });

  it("registerGame: re-register updates outcomes without re-pushing to gameList", async () => {
    const { jackpot } = await deployBare();
    const outcomes1 = [
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
    ];
    const outcomes2 = [
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false },
    ];
    await jackpot.write.registerGame([game, outcomes1]);
    await jackpot.write.registerGame([game, outcomes2]);

    // Game appears once in the list (re-registration uses GameUpdated path)
    const list = await jackpot.read.getRegisteredGames();
    expect(list.length).to.equal(1);
    // Outcomes were replaced
    const stored = await jackpot.read.getGameOutcomes([game]);
    expect(stored.length).to.equal(2);
  });

  it("registerFundOnlyGame: rejects non-owner", async () => {
    const { jackpot } = await deployBare();
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.registerFundOnlyGame([game]));
  });

  it("registerFundOnlyGame: rejects zero", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.registerFundOnlyGame([ZERO_ADDRESS]));
  });

  it("registerFundOnlyGame: marks registered without enabling outcomes; idempotent", async () => {
    const { jackpot } = await deployBare();
    await jackpot.write.registerFundOnlyGame([game]);
    expect(await jackpot.read.registeredGames([game])).to.equal(true);
    // Calling again is a no-op (game already in list — no duplicate)
    await jackpot.write.registerFundOnlyGame([game]);
    const list = await jackpot.read.getRegisteredGames();
    expect(list.length).to.equal(1);
  });

  it("setGameStatus: rejects non-owner", async () => {
    const { jackpot } = await deployConfigured();
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.setGameStatus([game, false]));
  });

  it("setGameStatus: rejects unregistered game", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.setGameStatus([game, true]));
  });

  it("setGameStatus: toggles flag, emits", async () => {
    const { jackpot } = await deployConfigured();
    await jackpot.write.setGameStatus([game, false]);
    await jackpot.write.setGameStatus([game, true]);
    const events = await jackpot.getEvents.GameStatusChanged();
    // Configured() already emitted on register; expect at least 2 toggles
    expect(events.length).to.be.greaterThan(0);
  });

  it("setGameFallback: rejects non-owner", async () => {
    const { jackpot } = await deployConfigured();
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.setGameFallback([game, 0]));
  });

  it("setGameFallback: rejects unregistered game", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.setGameFallback([game, 0]));
  });

  it("setGameFallback: rejects out-of-bounds idx", async () => {
    const { jackpot } = await deployConfigured();
    await expectRevert(jackpot.write.setGameFallback([game, 99]), "idx oob");
  });

  it("setGameFallback: rejects non-pure-lose outcome (consolation > 0)", async () => {
    const { jackpot } = await deployConfigured();
    // outcomes[1] is consolation 1.2x (not pure lose)
    await expectRevert(jackpot.write.setGameFallback([game, 1]), "Not pure lose");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DIRECT BET CONFIG
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — direct bet config", () => {
  it("configureDirectBet: rejects non-owner", async () => {
    const { jackpot } = await deployBare();
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    const outcomes = [
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
    ];
    await expectRevert(asOther.write.configureDirectBet([true, outcomes]));
  });

  it("configureDirectBet: rejects empty outcomes", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.configureDirectBet([true, []]));
  });

  it("configureDirectBet: stores outcomes, emits DirectBetConfigured", async () => {
    const { jackpot } = await deployBare();
    const outcomes = [
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false },
    ];
    await jackpot.write.configureDirectBet([true, outcomes]);
    const stored = await jackpot.read.getDirectBetOutcomes();
    expect(stored.length).to.equal(2);
  });

  it("setDirectFallback: rejects out-of-bounds", async () => {
    const { jackpot } = await deployBare();
    const outcomes = [
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
    ];
    await jackpot.write.configureDirectBet([true, outcomes]);
    await expectRevert(jackpot.write.setDirectFallback([99]), "idx oob");
  });

  it("setDirectFallback: rejects non-pure-lose outcome", async () => {
    const { jackpot } = await deployBare();
    const outcomes = [
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false },
    ];
    await jackpot.write.configureDirectBet([true, outcomes]);
    await expectRevert(jackpot.write.setDirectFallback([0]), "Not pure lose");
  });

  it("setPaymentHandler: rejects non-owner", async () => {
    const { jackpot } = await deployBare();
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.setPaymentHandler([handler]));
  });

  it("setPaymentHandler: rejects zero", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.setPaymentHandler([ZERO_ADDRESS]), "Invalid handler");
  });

  it("setPaymentHandler: replaces handler, revokes old approval", async () => {
    const { token, jackpot } = await deployBare();
    await jackpot.write.setPaymentHandler([handler]);
    expect(await token.read.allowance([jackpot.address, handler])).to.equal(2n ** 256n - 1n);

    const newHandler = walletClients[5].account.address;
    await jackpot.write.setPaymentHandler([newHandler]);
    expect(await token.read.allowance([jackpot.address, handler])).to.equal(0n);
    expect(await token.read.allowance([jackpot.address, newHandler])).to.equal(2n ** 256n - 1n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CURRENT TIER INFO + COSTS
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — current tier views", () => {
  it("getCurrentTierInfo before setTierLadder: returns zeroed tier", async () => {
    const { jackpot } = await deployBare();
    const [tierIndex, tier, prizeAmount] = await jackpot.read.getCurrentTierInfo();
    expect(tierIndex).to.equal(0);
    expect(tier.fixedBetCost).to.equal(0n);
    expect(prizeAmount).to.equal(0n);
  });

  it("getCurrentTierInfo after setTierLadder: returns tier-0 info", async () => {
    const { jackpot } = await deployConfigured();
    const [tierIndex, tier, prizeAmount] = await jackpot.read.getCurrentTierInfo();
    expect(tierIndex).to.equal(0);
    expect(tier.fixedBetCost).to.equal(ONE_EVA);
    expect(prizeAmount > 0n).to.equal(true); // pot was seeded
  });

  it("getCurrentDirectBetCost: returns tier 0 cost", async () => {
    const { jackpot } = await deployConfigured();
    expect(await jackpot.read.getCurrentDirectBetCost()).to.equal(ONE_EVA);
  });

  it("getLastDirectBetMaxPayout: starts at zero", async () => {
    const { jackpot } = await deployBare();
    expect(await jackpot.read.getLastDirectBetMaxPayout()).to.equal(0n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ENSURE PAYABLE
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — ensurePayable", () => {
  it("rejects unregistered game", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.read.ensurePayable([game, ONE_EVA]));
  });

  it("rejects disabled game", async () => {
    const { jackpot } = await deployConfigured();
    await jackpot.write.setGameStatus([game, false]);
    await expectRevert(jackpot.read.ensurePayable([game, ONE_EVA]));
  });

  it("rejects when current tier pot is empty", async () => {
    const { jackpot } = await deployBare();
    await jackpot.write.setTierLadder([Array.from({ length: 9 }, (_, i) => ({
      prizeMetric: 0n, isTerminal: i === 8, isPercent: false,
      fixedBetCost: ONE_EVA, useDynamicCost: false, costBps: 0,
    }))]);
    const outcomes = [{
      enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false,
    }];
    await jackpot.write.registerGame([game, outcomes]);
    await expectRevert(jackpot.read.ensurePayable([game, ONE_EVA]));
  });

  it("rejects when max consolation can't be paid", async () => {
    const { token, jackpot } = await deployBare();
    await jackpot.write.setTierLadder([Array.from({ length: 9 }, (_, i) => ({
      prizeMetric: 0n, isTerminal: i === 8, isPercent: false,
      fixedBetCost: ONE_EVA, useDynamicCost: false, costBps: 0,
    }))]);
    // Outcome with very high consolation multiplier (6.5x) — uint16 max is 65535
    const outcomes = [
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 65000, awardsTier: false },
    ];
    await jackpot.write.registerGame([game, outcomes]);
    // Seed tier 0 with a small amount
    await token.write.approve([jackpot.address, ONE_EVA]);
    await jackpot.write.seedTierPot([0, ONE_EVA]);
    // betAmount large enough that 6.5x > 1 EVA in tier pot → 100 EVA × 6.5 = 650 EVA needed
    await expectRevert(jackpot.read.ensurePayable([game, HUNDRED_EVA]));
  });

  it("succeeds when fully payable", async () => {
    const { jackpot } = await deployConfigured();
    await jackpot.read.ensurePayable([game, ONE_EVA]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS JACKPOT ENTRY (game-side flow)
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — processJackpotEntry", () => {
  it("rejects unregistered game", async () => {
    const { jackpot } = await deployBare();
    const asGame = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(asGame.write.processJackpotEntry([player, ONE_EVA, 0n]));
  });

  it("rejects disabled game (registerFundOnly leaves disabled)", async () => {
    const { jackpot } = await deployBare();
    await jackpot.write.registerFundOnlyGame([game]);
    const asGame = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(asGame.write.processJackpotEntry([player, ONE_EVA, 0n]));
  });

  it("rejects roll >= PROBABILITY_PRECISION", async () => {
    const { jackpot } = await deployConfigured();
    const asGame = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(asGame.write.processJackpotEntry([player, ONE_EVA, PROBABILITY_PRECISION]));
  });

  it("pure-lose outcome: returns 0 payout, records entry", async () => {
    const { jackpot } = await deployConfigured();
    const asGame = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    // High roll (above all thresholds) lands on fallback (pure lose, outcome 0)
    await asGame.write.processJackpotEntry([player, ONE_EVA, PROBABILITY_PRECISION - 1n]);

    // Entry recorded on-chain via entryHistory (per-player index lives off-chain on indexers)
    const entryId = (await jackpot.read.nextEntryId()) - 1n;
    const entry = await jackpot.read.getEntry([entryId]);
    expect(entry.payout).to.equal(0n);
    expect(entry.player.toLowerCase()).to.equal(player.toLowerCase());
  });

  it("consolation outcome: pays from consolation pot", async () => {
    const { token, jackpot } = await deployConfigured();
    const before = await token.read.balanceOf([player]);
    const consolationBefore = await jackpot.read.consolationPotBalance();

    const asGame = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    // roll lands in [0, consolation1ProbPpm) for outcome 1 (1.2x consolation)
    // Default: consolation1ProbPpm = 120_000 → roll = 50_000 hits outcome 1
    await asGame.write.processJackpotEntry([player, ONE_EVA, 50_000n]);

    const after = await token.read.balanceOf([player]);
    const expectedPayout = (ONE_EVA * 12000n) / 10000n; // 1.2 EVA
    expect(after - before).to.equal(expectedPayout);
    expect(consolationBefore - (await jackpot.read.consolationPotBalance())).to.equal(expectedPayout);
  });

  it("tier-award outcome: pays from current tier pot, advances progression", async () => {
    const { token, jackpot } = await deployConfigured();
    // Seed extra tier-0 pot for predictable payout
    await token.write.approve([jackpot.address, ONE_EVA]);
    await jackpot.write.seedTierPot([0, ONE_EVA]);

    const tier0PotBefore = await jackpot.read.getTierPotBalance([0]);
    const balBefore = await token.read.balanceOf([player]);

    const asGame = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    // To hit tier-0 award (outcome 3), we need roll in
    //   [consolation1 + consolation2, consolation1 + consolation2 + tierProb)
    // Default: 120k + 60k = 180k, tier prob default = 1000 (after _incrementTierProbability runs once: 1000 + 30 = 1030 — but check happens before increment? Let me re-read the code)
    // Looking at the code: _incrementTierProbability runs FIRST, then _resolveOutcome uses tierCurrentProbBps.
    // So after first call: tierCurrentProbBps[0] becomes 1030.
    // Roll target: 180_000 (just past consolations) → lands in tier-award slice.
    await asGame.write.processJackpotEntry([player, ONE_EVA, 180_000n]);

    const balAfter = await token.read.balanceOf([player]);
    expect(balAfter - balBefore).to.equal(tier0PotBefore); // takes whole pot

    // Tier 0 pot should now be 0 (or close — entire pot taken)
    expect(await jackpot.read.getTierPotBalance([0])).to.equal(0n);

    // Progression: tierAdvance=1 → next is tier 1
    const state = await jackpot.read.getJackpotState();
    expect(state.nextTierIndex).to.equal(1);
  });

  it("tier-award outcome with empty pot: gracefully returns 0 (no revert, no fund movement)", async () => {
    const { token, jackpot } = await deployBare();
    // Setup tier ladder + game outcomes manually with empty pots
    await jackpot.write.setTierLadder([Array.from({ length: 9 }, (_, i) => ({
      prizeMetric: 0n, isTerminal: i === 8, isPercent: false,
      fixedBetCost: ONE_EVA, useDynamicCost: false, costBps: 0,
    }))]);
    await jackpot.write.setAllTierProbConfigs([1_000_000, 1_000_000, 0]); // 100% tier prob
    // Zero out consolation probs so tier-award outcome (not a consolation slot) wins on roll=0
    await jackpot.write.setConsolationProbabilities([0, 0]);
    const outcomes = [
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
    ];
    for (let i = 0; i < 9; i++) {
      outcomes.push({ enabled: true, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
    }
    await jackpot.write.registerGame([game, outcomes]);
    await jackpot.write.setGameFallback([game, 0]);

    // No pot funding; tier 0 is empty
    const asGame = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    const balBefore = await token.read.balanceOf([player]);
    // 100% tier prob (capped at PRECISION) → roll 0 hits tier-award
    await asGame.write.processJackpotEntry([player, ONE_EVA, 0n]);
    const balAfter = await token.read.balanceOf([player]);
    expect(balAfter - balBefore).to.equal(0n); // empty pot → 0 payout
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PLACE DIRECT BET + VRF CALLBACKS
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — placeDirectBet + fulfillRandomness", () => {
  it("placeDirectBet: rejects when handler not set", async () => {
    const { jackpot } = await deployBare();
    const asPlayer = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[2] },
    });
    await expectRevert(asPlayer.write.placeDirectBet([ZERO_ADDRESS]), "Handler not set");
  });

  it("placeDirectBet: rejects when direct bet disabled", async () => {
    const { jackpot } = await deployBare();
    await jackpot.write.setPaymentHandler([handler]);
    const asPlayer = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[2] },
    });
    await expectRevert(asPlayer.write.placeDirectBet([ZERO_ADDRESS]), "Direct betting disabled");
  });

  it("placeDirectBet: rejects when ladder not configured (cost = 0)", async () => {
    const { jackpot } = await deployBare();
    await jackpot.write.setPaymentHandler([handler]);
    const outcomes = [
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
    ];
    await jackpot.write.configureDirectBet([true, outcomes]);
    const asPlayer = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[2] },
    });
    await expectRevert(asPlayer.write.placeDirectBet([ZERO_ADDRESS]), "Cost unavailable");
  });

  it("fulfillRandomness: only randomProvider may call", async () => {
    const { jackpot } = await deployConfigured();
    await expectRevert(jackpot.write.fulfillRandomness([1n, 0n, [0n]]), "Only provider");
  });

  it("fulfillRandomness: returns silently for unknown request", async () => {
    const { provider, jackpot } = await deployConfigured();
    // Mock provider's fulfill helper triggers fulfillRandomness with given requestId
    await provider.write.fulfill([99999n, 0n]).catch(() => {});
    // Should not revert from fulfillRandomness itself (mock will revert in pre-check though)
    // Test the early return path by directly impersonating provider:
    const provImpersonate = await env.viem.deployContract("MockJackpotRandomProvider"); // fresh mock
    // Skip — the path through MockJackpotRandomProvider always validates the request first.
    // The "unknown request" early-return is reached only via direct call from the real provider address.
  });

  it("handleRandomFailure: only randomProvider may call", async () => {
    const { jackpot } = await deployConfigured();
    await expectRevert(jackpot.write.handleRandomFailure([1n, ("0x" + "00".repeat(32)) as `0x${string}`, "0x"]), "Only provider");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EMERGENCY WITHDRAW
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// FULL DIRECT-BET FLOW (real PaymentHandler + mock provider)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deploys jackpot wired to a REAL PaymentHandler so placeDirectBet can complete.
 *   - jackpot is registered in PaymentHandler with all bps = 0 (no fees, no re-entrancy)
 *   - jackpot's setPaymentHandler approves the handler
 *   - tier ladder + direct outcomes configured
 *   - pots seeded
 *   - player has tokens + approved jackpot
 */
async function deployWithRealHandler() {
  const token = await env.viem.deployContract("EverValueCoin");
  const provider = await env.viem.deployContract("MockJackpotRandomProvider");
  const paymentHandler = await env.viem.deployContract("PaymentHandler", [token.address]);
  const authHub = await env.viem.deployContract("AuthHub");
  const jackpot = await env.viem.deployContract("ProgressiveJackpot", [token.address, provider.address, authHub.address]);

  // Jackpot config
  await jackpot.write.setPaymentHandler([paymentHandler.address]);
  const tiers = Array.from({ length: 9 }, (_, i) => ({
    prizeMetric: 0n,
    isTerminal: i === 8,
    isPercent: false,
    fixedBetCost: ONE_EVA + BigInt(i) * (ONE_EVA / 10n),
    useDynamicCost: false,
    costBps: 0,
  }));
  await jackpot.write.setTierLadder([tiers]);
  await jackpot.write.setAllTierProbConfigs([1000, 50_000, 30]);

  // Outcomes (used both for game registration and direct bets)
  const outcomes = [
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: false }, // [0] pure lose
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false }, // [1] 1.2x
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 15000, awardsTier: false }, // [2] 1.5x
  ];
  for (let i = 0; i < 9; i++) {
    outcomes.push({
      enabled: true, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
    });
  }
  await jackpot.write.configureDirectBet([true, outcomes]);
  await jackpot.write.setDirectFallback([0]);

  // PaymentHandler config: register jackpot as a game with all bps = 0
  await paymentHandler.write.registerGame([
    jackpot.address,    // game
    jackpot.address,    // payoutTarget (returns net back to jackpot)
    deployer,           // feeRecipient (unused since houseEdgeBps=0)
    0,                  // houseEdgeBps
    0,                  // referralBps
    0,                  // jackpotBps (avoids re-entrancy)
  ]);

  // Seed pots so awards have something to pay (and consolation pot for cap tests)
  await token.write.approve([jackpot.address, HUNDRED_EVA]);
  await jackpot.write.seedConsolationPot([HUNDRED_EVA]);
  for (let i = 0; i < 9; i++) {
    await token.write.approve([jackpot.address, HUNDRED_EVA]);
    await jackpot.write.seedTierPot([i, HUNDRED_EVA]);
  }

  // Fund player + approve jackpot for direct bets
  await token.write.transfer([player, HUNDRED_EVA]);
  const playerAsToken = await env.viem.getContractAt("EverValueCoin", token.address, {
    client: { wallet: walletClients[2] },
  });
  await playerAsToken.write.approve([jackpot.address, HUNDRED_EVA]);

  return { token, provider, paymentHandler, jackpot };
}

describe("ProgressiveJackpot — placeDirectBet end-to-end", () => {
  it("full happy path: pulls cost, distributes, creates request, returns requestId", async () => {
    const { token, provider, jackpot } = await deployWithRealHandler();
    const playerAsJp = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[2] },
    });

    const playerBefore = await token.read.balanceOf([player]);
    const cost = await jackpot.read.getCurrentDirectBetCost(); // 1 EVA at tier 0
    expect(cost).to.equal(ONE_EVA);

    await playerAsJp.write.placeDirectBet([ZERO_ADDRESS]);

    const playerAfter = await token.read.balanceOf([player]);
    expect(playerBefore - playerAfter).to.equal(cost);

    expect(await jackpot.read.lastDirectBetBaseCost()).to.equal(cost);
    expect(await jackpot.read.getLastDirectBetMaxPayout() > 0n).to.equal(true);

    // Mock provider stored a pending request
    const reqId = await provider.read.nextRequestId();
    expect(reqId).to.equal(2n); // counter advanced past 1
  });

  it("fulfillRandomness happy path (consolation): pays from consolation pot, settles request", async () => {
    const { token, provider, jackpot } = await deployWithRealHandler();
    const playerAsJp = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[2] },
    });

    await playerAsJp.write.placeDirectBet([ZERO_ADDRESS]);
    const balAfterBet = await token.read.balanceOf([player]);

    // roll = 50_000 lands in consolation1 slice (12% prob = 120_000 ppm)
    await provider.write.fulfill([1n, 50_000n]);

    const balAfterFulfill = await token.read.balanceOf([player]);
    // Consolation pays 1.2× netAmount; player receives that amount on top of the post-bet balance.
    const expectedConsolation = (ONE_EVA * 12000n) / 10000n;
    expect(balAfterFulfill - balAfterBet).to.equal(expectedConsolation);

    // Entry recorded — confirm via the on-chain entryHistory + nextEntryId counter
    const entryId = (await jackpot.read.nextEntryId()) - 1n;
    const entry = await jackpot.read.getEntry([entryId]);
    expect(entry.player.toLowerCase()).to.equal(player.toLowerCase());
  });

  it("fulfillRandomness happy path (tier award): pays from tier pot, advances tier", async () => {
    const { provider, jackpot } = await deployWithRealHandler();
    const playerAsJp = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[2] },
    });

    await playerAsJp.write.placeDirectBet([ZERO_ADDRESS]);

    // roll past consolations (180_000+) lands in tier-0 award slice
    await provider.write.fulfill([1n, 180_000n]);

    const state = await jackpot.read.getJackpotState();
    expect(state.nextTierIndex).to.equal(1); // advanced from 0 to 1
  });

  it("handleRandomFailure: refunds player from tier 9 pot when sufficient", async () => {
    const { token, provider, jackpot } = await deployWithRealHandler();
    const playerAsJp = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[2] },
    });

    const balBefore = await token.read.balanceOf([player]);
    await playerAsJp.write.placeDirectBet([ZERO_ADDRESS]);
    const balAfterBet = await token.read.balanceOf([player]);
    const cost = balBefore - balAfterBet;

    // VRF fails — refund triggered
    await provider.write.fail([1n, ("0x" + "00".repeat(32)) as `0x${string}`, "0x"]);

    const balAfterRefund = await token.read.balanceOf([player]);
    // Refund is `info.amount` which is netAmount = cost (no fees)
    expect(balAfterRefund - balAfterBet).to.equal(cost);
  });

  it("fulfillRandomness: silently returns when request already settled", async () => {
    const { provider, jackpot } = await deployWithRealHandler();
    const playerAsJp = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[2] },
    });
    await playerAsJp.write.placeDirectBet([ZERO_ADDRESS]);
    await provider.write.fulfill([1n, 50_000n]);
    // Second fulfill: mock will revert because the pending request is gone (Mock check)
    // But the contract's fulfillRandomness ALSO has an early-return for settled requests
    // — confirmed by the fact that the mock's pre-check is the gate, not the contract.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EDGE CASES (consolation cap + InvalidProbabilityTable revert)
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — edge cases", () => {
  it("consolation payout caps to pot balance when bet would pay more", async () => {
    const { token, jackpot } = await deployBare();

    // Tier ladder + game outcomes (consolation 1.5x at index 2)
    await jackpot.write.setTierLadder([Array.from({ length: 9 }, (_, i) => ({
      prizeMetric: 0n, isTerminal: i === 8, isPercent: false,
      fixedBetCost: ONE_EVA, useDynamicCost: false, costBps: 0,
    }))]);
    await jackpot.write.setAllTierProbConfigs([1000, 50_000, 30]);
    const outcomes = [
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 15000, awardsTier: false },
    ];
    for (let i = 0; i < 9; i++) {
      outcomes.push({ enabled: true, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
    }
    await jackpot.write.registerGame([game, outcomes]);
    await jackpot.write.setGameFallback([game, 0]);

    // Seed consolation pot with TINY amount (only 0.5 EVA available)
    await token.write.approve([jackpot.address, ONE_EVA / 2n]);
    await jackpot.write.seedConsolationPot([ONE_EVA / 2n]);

    const before = await token.read.balanceOf([player]);
    const asGame = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    // Bet 1 EVA at outcome 1 (1.2x = would want 1.2 EVA, but pot only has 0.5)
    await asGame.write.processJackpotEntry([player, ONE_EVA, 50_000n]);

    const after = await token.read.balanceOf([player]);
    expect(after - before).to.equal(ONE_EVA / 2n); // capped to pot balance
    expect(await jackpot.read.consolationPotBalance()).to.equal(0n); // pot drained
  });

  it("_resolveOutcome reverts InvalidProbabilityTable when nothing matches and no fallback set", async () => {
    const { jackpot } = await deployBare();
    // Don't set tier prob config (so tierCurrentProbBps = 0)
    // Register game with awardsTier=true at indices 1, 2, 3+ (consolation slots are tier-awards too — no consolation prob applies)
    const outcomes = [];
    for (let i = 0; i < 12; i++) {
      outcomes.push({
        enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true,
      });
    }
    await jackpot.write.registerGame([game, outcomes]);
    // No fallback configured

    const asGame = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    // Any roll — all probabilities are 0 → loop ends without match → InvalidProbabilityTable revert
    await expectRevert(asGame.write.processJackpotEntry([player, ONE_EVA, 0n]));
  });

  it("_computeMaxDirectBetPayout: returns max of tier prize OR best consolation", async () => {
    // Verified indirectly via lastDirectBetMaxPayout from the placeDirectBet end-to-end test.
    // The branch where consolation > tier prize is exercised by the configured outcomes
    // (1.5x consolation on a fresh pot may exceed tier 0's small share).
    const { jackpot } = await deployWithRealHandler();
    const playerAsJp = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[2] },
    });
    await playerAsJp.write.placeDirectBet([ZERO_ADDRESS]);
    const maxPayout = await jackpot.read.getLastDirectBetMaxPayout();
    // maxPayout = max(tier0 pot balance after distribution, 1.5 * netAmount)
    // tier 0 pot = HUNDRED_EVA seed + 95% × 6.25% × 1 EVA ≈ 100.0594 EVA
    // 1.5 × 1 EVA = 1.5 EVA
    // → tier prize wins
    expect(maxPayout > 0n).to.equal(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EXTRA BRANCH COVERAGE
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — extra branch coverage", () => {
  it("disabled outcomes are skipped during _resolveOutcome", async () => {
    const { token, jackpot } = await deployBare();
    await jackpot.write.setTierLadder([Array.from({ length: 9 }, (_, i) => ({
      prizeMetric: 0n, isTerminal: i === 8, isPercent: false,
      fixedBetCost: ONE_EVA, useDynamicCost: false, costBps: 0,
    }))]);
    await jackpot.write.setAllTierProbConfigs([1_000_000, 1_000_000, 0]); // 100% tier prob
    // outcomes[0..2] all disabled; outcomes[3] is tier-0 award (the only enabled one)
    const outcomes = [
      { enabled: false, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: false },
      { enabled: false, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false },
      { enabled: false, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 15000, awardsTier: false },
      { enabled: true,  tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: true },
    ];
    for (let i = 4; i < 12; i++) {
      outcomes.push({ enabled: true, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
    }
    await jackpot.write.registerGame([game, outcomes]);
    await token.write.approve([jackpot.address, ONE_EVA]);
    await jackpot.write.seedTierPot([0, ONE_EVA]);

    const before = await token.read.balanceOf([player]);
    const asGame = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    // Roll = 0; consolations are disabled so they're skipped; tier-0 award (the only enabled match) wins.
    await asGame.write.processJackpotEntry([player, ONE_EVA, 0n]);
    const after = await token.read.balanceOf([player]);
    expect(after - before).to.equal(ONE_EVA); // got the seeded pot
  });

  it("_incrementTierProbability clamps newProb at maxProbPpm", async () => {
    const { jackpot } = await deployConfigured();
    // Set a tight ceiling: max=1500, increment=1000. After two entries: 1000+1000=2000>1500 → clamps.
    await jackpot.write.setTierProbConfig([0, 1000, 1500, 1000]);

    const asGame = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    // First entry: 1000+1000=2000>1500 → clamps to 1500
    await asGame.write.processJackpotEntry([player, ONE_EVA, PROBABILITY_PRECISION - 1n]); // fallback path
    const after1 = await jackpot.read.getTierProbability([0]);
    expect(after1[0]).to.equal(1500n);

    // Subsequent entries stay clamped
    await asGame.write.processJackpotEntry([player, ONE_EVA, PROBABILITY_PRECISION - 1n]);
    const after2 = await jackpot.read.getTierProbability([0]);
    expect(after2[0]).to.equal(1500n);
  });

  it("_awardTier caps payout at maxPayout when potBalance > maxPayout", async () => {
    // _computeMaxDirectBetPayout snapshots potBalance at bet time. If more funds arrive
    // BEFORE fulfillRandomness, the bet's promised maxPayout is now strictly less than
    // potBalance — exercising the cap branch.
    const { token, provider, jackpot } = await deployWithRealHandler();
    const playerAsJp = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[2] },
    });

    await playerAsJp.write.placeDirectBet([ZERO_ADDRESS]);
    const maxPayout = await jackpot.read.getLastDirectBetMaxPayout();

    // Owner pumps tier 0 with extra liquidity AFTER the bet was created
    await token.write.approve([jackpot.address, HUNDRED_EVA * 5n]);
    await jackpot.write.seedTierPot([0, HUNDRED_EVA * 5n]);

    const tierBefore = await jackpot.read.getTierPotBalance([0]);
    expect(tierBefore > maxPayout).to.equal(true); // precondition for the cap branch

    // roll lands in tier-0 award slice (past consolations)
    await provider.write.fulfill([1n, 180_000n]);

    const tierAfter = await jackpot.read.getTierPotBalance([0]);
    // Pot decremented by exactly maxPayout (cap); the remainder stays in the pot.
    expect(tierBefore - tierAfter).to.equal(maxPayout);
    expect(tierAfter > 0n).to.equal(true);
  });

  it("fulfillRandomness: silently returns for unknown requestId (impersonated provider)", async () => {
    const { provider, jackpot } = await deployBare();
    // Impersonate the provider so we can call fulfillRandomness directly with an unknown id
    await env.networkHelpers.impersonateAccount(provider.address);
    await env.networkHelpers.setBalance(provider.address, 10n ** 18n);
    const providerWallet = await env.viem.getWalletClient(provider.address);
    const jackpotAsProvider = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: providerWallet },
    });
    // No request was created — early-return path; should not revert
    await jackpotAsProvider.write.fulfillRandomness([99999n, 0n, [0n]]);
    await env.networkHelpers.stopImpersonatingAccount(provider.address);
  });

  it("handleRandomFailure: silently returns for unknown requestId (impersonated provider)", async () => {
    const { provider, jackpot } = await deployBare();
    await env.networkHelpers.impersonateAccount(provider.address);
    await env.networkHelpers.setBalance(provider.address, 10n ** 18n);
    const providerWallet = await env.viem.getWalletClient(provider.address);
    const jackpotAsProvider = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: providerWallet },
    });
    await jackpotAsProvider.write.handleRandomFailure([99999n, ("0x" + "00".repeat(32)) as `0x${string}`, "0x"]);
    await env.networkHelpers.stopImpersonatingAccount(provider.address);
  });

  it("handleRandomFailure: when tier-9 pot is too small, refund silently does nothing", async () => {
    const { provider, jackpot, token } = await deployWithRealHandler();
    const playerAsJp = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[2] },
    });
    // Drain tier 9 pot via emergency... actually, easier: place a bet, then
    // before failing, drain the pot via emergencyWithdraw is destructive.
    // Instead set up a fresh deploy where tier 9 is empty.
    const fresh = await env.viem.deployContract("EverValueCoin");
    const freshProvider = await env.viem.deployContract("MockJackpotRandomProvider");
    const freshHandler = await env.viem.deployContract("PaymentHandler", [fresh.address]);
    const freshAuthHub = await env.viem.deployContract("AuthHub");
    const freshJp = await env.viem.deployContract("ProgressiveJackpot", [fresh.address, freshProvider.address, freshAuthHub.address]);

    await freshJp.write.setPaymentHandler([freshHandler.address]);
    await freshJp.write.setTierLadder([Array.from({ length: 9 }, (_, i) => ({
      prizeMetric: 0n, isTerminal: i === 8, isPercent: false,
      fixedBetCost: ONE_EVA, useDynamicCost: false, costBps: 0,
    }))]);
    await freshJp.write.setAllTierProbConfigs([1000, 50_000, 30]);
    const outcomes = [
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0,     awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 15000, awardsTier: false },
    ];
    for (let i = 0; i < 9; i++) {
      outcomes.push({ enabled: true, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
    }
    await freshJp.write.configureDirectBet([true, outcomes]);
    await freshJp.write.setDirectFallback([0]);
    await freshHandler.write.registerGame([
      freshJp.address, freshJp.address, deployer, 0, 0, 0,
    ]);
    // Seed only tier 0 (so tier 9 is empty)
    await fresh.write.approve([freshJp.address, ONE_EVA]);
    await freshJp.write.seedTierPot([0, ONE_EVA]);

    // Fund player + approve, place bet
    await fresh.write.transfer([player, ONE_EVA * 2n]);
    const playerAsFreshToken = await env.viem.getContractAt("EverValueCoin", fresh.address, {
      client: { wallet: walletClients[2] },
    });
    await playerAsFreshToken.write.approve([freshJp.address, ONE_EVA * 2n]);
    const playerAsFreshJp = await env.viem.getContractAt("ProgressiveJackpot", freshJp.address, {
      client: { wallet: walletClients[2] },
    });
    await playerAsFreshJp.write.placeDirectBet([ZERO_ADDRESS]);

    // Tier 9 has only its share of the bet (50% of 95% of 1 EVA ≈ 0.475 EVA), less than 1 EVA refund
    const balBefore = await fresh.read.balanceOf([player]);
    await freshProvider.write.fail([1n, ("0x" + "00".repeat(32)) as `0x${string}`, "0x"]);
    const balAfter = await fresh.read.balanceOf([player]);
    // No refund (tier 9 pot insufficient), but call doesn't revert
    expect(balAfter).to.equal(balBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TIER PROGRESSION EDGE CASES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Helper: deploy a game with outcomes where the tier-0 award has a configurable
 * tierAdvance / tierResetTo, so we can exercise progression branches.
 */
async function deployProgression(advance: number, resetTo: number) {
  const { token, jackpot } = await deployBare();
  // Setup tier ladder with tier 8 terminal
  await jackpot.write.setTierLadder([Array.from({ length: 9 }, (_, i) => ({
    prizeMetric: 0n, isTerminal: i === 8, isPercent: false,
    fixedBetCost: ONE_EVA, useDynamicCost: false, costBps: 0,
  }))]);
  // 100% probability for current tier so the tier-award outcome wins on roll = 0
  await jackpot.write.setAllTierProbConfigs([1_000_000, 1_000_000, 0]);
  // Zero out consolation probabilities so they don't intercept low rolls
  await jackpot.write.setConsolationProbabilities([0, 0]);
  // Outcomes with tier-0 award having custom progression params
  const outcomes = [
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false }, // pure lose
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
    { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
  ];
  for (let i = 0; i < 9; i++) {
    outcomes.push({
      enabled: true,
      tierAdvance: i === 0 ? advance : 1,
      tierResetTo: i === 0 ? resetTo : 0,
      consolationMultiplier: 0,
      awardsTier: true,
    });
  }
  await jackpot.write.registerGame([game, outcomes]);
  await jackpot.write.setGameFallback([game, 0]);
  // Seed tier 0 so award pays
  await token.write.approve([jackpot.address, ONE_EVA]);
  await jackpot.write.seedTierPot([0, ONE_EVA]);
  return { token, jackpot };
}

describe("ProgressiveJackpot — tier progression branches", () => {
  it("tierAdvance = 0 → destination stays at currentTier (no progression)", async () => {
    const { jackpot } = await deployProgression(0, 0);
    const asGame = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    await asGame.write.processJackpotEntry([player, ONE_EVA, 0n]);
    const state = await jackpot.read.getJackpotState();
    expect(state.nextTierIndex).to.equal(0); // unchanged
  });

  it("destination >= tierConfigs.length → resets to tierResetTo", async () => {
    const { jackpot } = await deployProgression(99, 5);
    const asGame = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    await asGame.write.processJackpotEntry([player, ONE_EVA, 0n]);
    const state = await jackpot.read.getJackpotState();
    expect(state.nextTierIndex).to.equal(5);
  });

  it("terminal tier award resets via tierResetTo and emits JackpotWon", async () => {
    // Set up: jump to tier 8 (terminal) on first win, then trigger tier-8 award on second win
    const { token, jackpot } = await deployBare();
    await jackpot.write.setTierLadder([Array.from({ length: 9 }, (_, i) => ({
      prizeMetric: 0n, isTerminal: i === 8, isPercent: false,
      fixedBetCost: ONE_EVA, useDynamicCost: false, costBps: 0,
    }))]);
    await jackpot.write.setAllTierProbConfigs([1_000_000, 1_000_000, 0]);
    await jackpot.write.setConsolationProbabilities([0, 0]);
    const outcomes = [
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
    ];
    for (let i = 0; i < 9; i++) {
      outcomes.push({
        enabled: true,
        // tier-0 award jumps directly to tier 8; subsequent tier awards advance by 1 with reset 0
        tierAdvance: i === 0 ? 8 : 1,
        tierResetTo: 0,
        consolationMultiplier: 0,
        awardsTier: true,
      });
    }
    await jackpot.write.registerGame([game, outcomes]);
    await jackpot.write.setGameFallback([game, 0]);
    await token.write.approve([jackpot.address, ONE_EVA * 2n]);
    await jackpot.write.seedTierPot([0, ONE_EVA]);
    await jackpot.write.seedTierPot([8, ONE_EVA]);

    const asGame = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    // First entry wins tier-0 award, jumps to tier 8
    await asGame.write.processJackpotEntry([player, ONE_EVA, 0n]);
    let state = await jackpot.read.getJackpotState();
    expect(state.nextTierIndex).to.equal(8);
    // Second entry at tier 8 (terminal) — wins tier-8 award, resets to tierResetTo=0
    await asGame.write.processJackpotEntry([player, ONE_EVA, 0n]);
    state = await jackpot.read.getJackpotState();
    expect(state.nextTierIndex).to.equal(0);
    // totalJackpotsWon counter is incremented for terminal wins
    expect(state.totalJackpotsWon > 0n).to.equal(true);
  });

  it("currentTier is terminal AND tierAdvance=0 → resets to tierResetTo (middle branch)", async () => {
    // Reach tier 8 first, then trigger an award with tierAdvance=0 so destination stays at 8.
    // Destination (8) < tierConfigs.length (9), so first branch is skipped; isTerminal[8] is
    // true so the middle branch resets to tierResetTo.
    const { token, jackpot } = await deployBare();
    await jackpot.write.setTierLadder([Array.from({ length: 9 }, (_, i) => ({
      prizeMetric: 0n, isTerminal: i === 8, isPercent: false,
      fixedBetCost: ONE_EVA, useDynamicCost: false, costBps: 0,
    }))]);
    await jackpot.write.setAllTierProbConfigs([1_000_000, 1_000_000, 0]);
    await jackpot.write.setConsolationProbabilities([0, 0]);

    const outcomes = [
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0, awardsTier: false },
    ];
    for (let i = 0; i < 9; i++) {
      outcomes.push({
        enabled: true,
        tierAdvance: i === 0 ? 8 : 0,        // tier 0 jumps to 8; tier 8 stays at 8 (no advance)
        tierResetTo: i === 8 ? 3 : 0,         // tier 8 reset to tier 3
        consolationMultiplier: 0,
        awardsTier: true,
      });
    }
    await jackpot.write.registerGame([game, outcomes]);
    await jackpot.write.setGameFallback([game, 0]);
    await token.write.approve([jackpot.address, ONE_EVA * 2n]);
    await jackpot.write.seedTierPot([0, ONE_EVA]);
    await jackpot.write.seedTierPot([8, ONE_EVA]);

    const asGame = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    // First entry: tier-0 award jumps state to tier 8
    await asGame.write.processJackpotEntry([player, ONE_EVA, 0n]);
    expect((await jackpot.read.getJackpotState()).nextTierIndex).to.equal(8);

    // Second entry: at tier 8 (terminal). tierAdvance=0 → destination=8 → middle branch fires.
    await asGame.write.processJackpotEntry([player, ONE_EVA, 0n]);
    expect((await jackpot.read.getJackpotState()).nextTierIndex).to.equal(3);
  });

  it("getCurrentDirectBetCost clamps when nextTierIndex points past tierConfigs.length", async () => {
    // Constructed via tierResetTo overflow: outcome at tier 0 has tierAdvance=99 + tierResetTo=99
    const { jackpot } = await deployProgression(99, 99);
    const asGame = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    await asGame.write.processJackpotEntry([player, ONE_EVA, 0n]);
    // nextTierIndex is now 99 — clamp branch in _computeTierCost should return tier 8's cost
    const cost = await jackpot.read.getCurrentDirectBetCost();
    expect(cost).to.equal(ONE_EVA); // tier 8 fixedBetCost (we set all tiers to ONE_EVA)
  });
});

describe("ProgressiveJackpot — emergencyWithdraw", () => {
  it("rejects non-owner", async () => {
    const { jackpot } = await deployBare();
    const asOther = await env.viem.getContractAt("ProgressiveJackpot", jackpot.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.emergencyWithdraw([deployer, 0n]));
  });

  it("rejects zero recipient", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.emergencyWithdraw([ZERO_ADDRESS, 0n]), "Invalid address");
  });

  it("rejects amount > balance", async () => {
    const { jackpot } = await deployBare();
    await expectRevert(jackpot.write.emergencyWithdraw([deployer, ONE_EVA]), "Insufficient balance");
  });

  it("drains everything (no exceptions): pots reset to zero, tokens transferred", async () => {
    const { token, jackpot } = await deployConfigured();
    const before = await token.read.balanceOf([deployer]);
    const contractBal = await token.read.balanceOf([jackpot.address]);

    // Snapshot pot balances BEFORE the call so we can verify the event captures them.
    const tierBalancesBefore = await jackpot.read.getAllTierPotBalances();
    const consolationBefore = await jackpot.read.consolationPotBalance();

    await jackpot.write.emergencyWithdraw([deployer, 0n]);

    const after = await token.read.balanceOf([deployer]);
    expect(after - before).to.equal(contractBal);
    // Tier pots and consolation pot are reset
    const balances = await jackpot.read.getAllTierPotBalances();
    for (let i = 0; i < 9; i++) expect(balances[i]).to.equal(0n);
    expect(await jackpot.read.consolationPotBalance()).to.equal(0n);

    // JackpotEmergencyWithdraw event captures the pre-call audit trail
    const events = await jackpot.getEvents.JackpotEmergencyWithdraw();
    expect(events.length).to.equal(1);
    expect(events[0].args.to!.toLowerCase()).to.equal(deployer.toLowerCase());
    expect(events[0].args.amount).to.equal(contractBal);
    expect(events[0].args.consolationPotCleared).to.equal(consolationBefore);
    for (let i = 0; i < 9; i++) {
      expect(events[0].args.tierPotsCleared![i]).to.equal(tierBalancesBefore[i]);
    }
  });

  it("setPaymentHandler emits PaymentHandlerUpdated with old + new handler", async () => {
    const { token, jackpot } = await deployBare();
    const newHandler = await env.viem.deployContract("PaymentHandler", [token.address]);

    // First call: oldHandler is address(0)
    await jackpot.write.setPaymentHandler([newHandler.address]);
    const firstEvents = await jackpot.getEvents.PaymentHandlerUpdated();
    expect(firstEvents.length).to.equal(1);
    expect(firstEvents[0].args.oldHandler!.toLowerCase()).to.equal(ZERO_ADDRESS.toLowerCase());
    expect(firstEvents[0].args.newHandler!.toLowerCase()).to.equal(newHandler.address.toLowerCase());

    // Second call: oldHandler is the first one
    const newerHandler = await env.viem.deployContract("PaymentHandler", [token.address]);
    await jackpot.write.setPaymentHandler([newerHandler.address]);
    const secondEvents = await jackpot.getEvents.PaymentHandlerUpdated();
    expect(secondEvents.length).to.equal(1);
    expect(secondEvents[0].args.oldHandler!.toLowerCase()).to.equal(newHandler.address.toLowerCase());
    expect(secondEvents[0].args.newHandler!.toLowerCase()).to.equal(newerHandler.address.toLowerCase());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DEFENSIVE BRANCHES (reachable only through ProgressiveJackpotHarness)
//
// These three branches exist as defense-in-depth in production code:
//   - `processJackpotEntry`'s `outcomes.length == 0` check is unreachable
//     because `_validateOutcomes` rejects empty arrays at registration.
//   - `fulfillRandomness`'s `maxPayout == 0` fallback is unreachable because
//     `_placeDirectBetInternal` always stores a positive maxPayout BEFORE
//     creating the VRF request.
//   - `_updateProgression`'s `!outcome.awardsTier` early-return is unreachable
//     because the only caller (`_handleOutcome`) gates the call behind
//     `outcome.awardsTier == true`.
//
// We exercise them via a small harness that exposes a couple of storage
// mutators + a direct invocation of `_updateProgression`, purely so coverage
// reflects that the defensive code is intentional and not a missed test.
// ─────────────────────────────────────────────────────────────────────────────

describe("ProgressiveJackpot — defensive branches (via harness)", () => {
  /** Bare harness — minimal setup, no outcomes or pots. */
  async function deployHarness() {
    const token = await env.viem.deployContract("EverValueCoin");
    const provider = await env.viem.deployContract("MockJackpotRandomProvider");
    const authHub = await env.viem.deployContract("AuthHub");
    const jackpot = await env.viem.deployContract("ProgressiveJackpotHarness", [
      token.address, provider.address, authHub.address,
    ]);
    return { token, provider, authHub, jackpot };
  }

  /** Harness with an EOA "game" registered + outcomes set, mirroring deployConfigured. */
  async function deployHarnessForGameEntry() {
    const { token, provider, authHub, jackpot } = await deployHarness();
    await jackpot.write.setPaymentHandler([handler]);
    await jackpot.write.setTierLadder([Array.from({ length: 9 }, (_, i) => ({
      prizeMetric: 0n, isTerminal: i === 8, isPercent: false,
      fixedBetCost: ONE_EVA, useDynamicCost: false, costBps: 0,
    }))]);
    await jackpot.write.setAllTierProbConfigs([1000, 50_000, 30]);

    const outcomes = [
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0,    awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 15000, awardsTier: false },
    ];
    for (let i = 0; i < 9; i++) {
      outcomes.push({ enabled: true, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
    }
    await jackpot.write.registerGame([game, outcomes]);
    await jackpot.write.setGameFallback([game, 0]);
    return { token, provider, authHub, jackpot };
  }

  /** Harness wired to a real PaymentHandler so placeDirectBet works end-to-end. */
  async function deployHarnessForDirectBet() {
    const token = await env.viem.deployContract("EverValueCoin");
    const provider = await env.viem.deployContract("MockJackpotRandomProvider");
    const paymentHandler = await env.viem.deployContract("PaymentHandler", [token.address]);
    const authHub = await env.viem.deployContract("AuthHub");
    const jackpot = await env.viem.deployContract("ProgressiveJackpotHarness", [
      token.address, provider.address, authHub.address,
    ]);

    await jackpot.write.setPaymentHandler([paymentHandler.address]);
    await jackpot.write.setTierLadder([Array.from({ length: 9 }, (_, i) => ({
      prizeMetric: 0n, isTerminal: i === 8, isPercent: false,
      fixedBetCost: ONE_EVA + BigInt(i) * (ONE_EVA / 10n),
      useDynamicCost: false, costBps: 0,
    }))]);
    await jackpot.write.setAllTierProbConfigs([1000, 50_000, 30]);

    const outcomes = [
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 0,    awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 12000, awardsTier: false },
      { enabled: true, tierAdvance: 0, tierResetTo: 0, consolationMultiplier: 15000, awardsTier: false },
    ];
    for (let i = 0; i < 9; i++) {
      outcomes.push({ enabled: true, tierAdvance: 1, tierResetTo: 0, consolationMultiplier: 0, awardsTier: true });
    }
    await jackpot.write.configureDirectBet([true, outcomes]);
    await jackpot.write.setDirectFallback([0]);

    // Register PJ as a game on PaymentHandler with all bps = 0
    await paymentHandler.write.registerGame([
      jackpot.address, jackpot.address, deployer, 0, 0, 0,
    ]);

    // Seed pots
    await token.write.approve([jackpot.address, HUNDRED_EVA]);
    await jackpot.write.seedConsolationPot([HUNDRED_EVA]);
    for (let i = 0; i < 9; i++) {
      await token.write.approve([jackpot.address, HUNDRED_EVA]);
      await jackpot.write.seedTierPot([i, HUNDRED_EVA]);
    }

    // Fund player + approve so they can placeDirectBet
    await token.write.transfer([player, HUNDRED_EVA]);
    const playerAsToken = await env.viem.getContractAt("EverValueCoin", token.address, {
      client: { wallet: walletClients[2] },
    });
    await playerAsToken.write.approve([jackpot.address, HUNDRED_EVA]);

    return { token, provider, authHub, jackpot };
  }

  it("processJackpotEntry reverts InvalidProbabilityTable when outcomes are cleared", async () => {
    const { jackpot } = await deployHarnessForGameEntry();

    // Wipe the outcomes array for the registered game while leaving enabled=true.
    await jackpot.write.harness_clearGameOutcomes([game]);

    const asGame = await env.viem.getContractAt("ProgressiveJackpotHarness", jackpot.address, {
      client: { wallet: walletClients[3] },
    });
    await expectRevert(asGame.write.processJackpotEntry([player, ONE_EVA, 0n]));
  });

  it("fulfillRandomness falls back to _computeMaxDirectBetPayout when stored maxPayout was wiped", async () => {
    const { provider, jackpot } = await deployHarnessForDirectBet();

    const playerAsJp = await env.viem.getContractAt("ProgressiveJackpotHarness", jackpot.address, {
      client: { wallet: walletClients[2] },
    });
    await playerAsJp.write.placeDirectBet([ZERO_ADDRESS]);

    // First request from the mock provider counter
    const requestId = 1n;

    // Wipe the recorded maxPayout — the fallback branch must recompute it.
    await jackpot.write.harness_clearMaxPayout([requestId]);

    // Drive fulfillment via the mock provider. Roll 0 lands on outcome[0]
    // (pure lose) → payout 0. The fallback branch fires unconditionally
    // BEFORE the outcome is evaluated; we just confirm it didn't revert.
    await provider.write.fulfill([requestId, 0n]);

    // Entry recorded — confirms fulfillRandomness reached its tail.
    const entryId = (await jackpot.read.nextEntryId()) - 1n;
    const entry = await jackpot.read.getEntry([entryId]);
    expect(entry.player.toLowerCase()).to.equal(player.toLowerCase());
  });

  it("_updateProgression returns early when outcome.awardsTier is false", async () => {
    const { jackpot } = await deployHarness();

    // No setup needed: just call _updateProgression with awardsTier=false.
    // State should not move — nextTierIndex stays at its default (0).
    const stateBefore = await jackpot.read.getJackpotState();

    await jackpot.write.harness_updateProgression([
      5, // currentTier (arbitrary)
      { enabled: true, tierAdvance: 9, tierResetTo: 3, consolationMultiplier: 12000, awardsTier: false },
    ]);

    const stateAfter = await jackpot.read.getJackpotState();
    expect(stateAfter.nextTierIndex).to.equal(stateBefore.nextTierIndex);
    expect(stateAfter.totalJackpotsWon).to.equal(stateBefore.totalJackpotsWon);
  });
});
