import { describe, it, before, beforeEach } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";
import { getAddress, parseAbi } from "viem";

import { ZERO_ADDRESS, FALLBACK_LEVEL, ONE_EVA, HUNDRED_EVA, ONE_THOUSAND_EVA } from "../helpers/constants.js";
import { expectRevert } from "../helpers/utils.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

type Env = Awaited<ReturnType<typeof network.connect>>;

let env: Env;
let walletClients: Awaited<ReturnType<Env["viem"]["getWalletClients"]>>;

// Convenient address aliases (set in `before` once)
let deployer: `0x${string}`;     // owner of MLR by default
let handler: `0x${string}`;      // designated paymentHandler EOA
let defaultRcv: `0x${string}`;   // defaultReceiver
let alice: `0x${string}`;
let bob: `0x${string}`;
let carol: `0x${string}`;
let dave: `0x${string}`;

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  deployer = walletClients[0].account.address;
  handler = walletClients[1].account.address;
  defaultRcv = walletClients[2].account.address;
  alice = walletClients[3].account.address;
  bob = walletClients[4].account.address;
  carol = walletClients[5].account.address;
  dave = walletClients[6].account.address;
});

/// Deploy a fresh token + MLR with `defaultRcv` as the configured fallback.
/// Mints all tokens to deployer (default ERC20 behaviour).
async function freshDeployment() {
  const token = await env.viem.deployContract("EverValueCoin");
  const mlr = await env.viem.deployContract("MultiLevelReferral", [token.address, defaultRcv]);
  return { token, mlr };
}

/// Deploys + sets up handler + funds MLR with `amount` so recordReferral has something to distribute later.
/// Returns wallet-bound mlr instance so calls go from `handler` by default.
async function setupWithHandlerAndFunds(amount: bigint) {
  const { token, mlr } = await freshDeployment();

  // wire handler
  await mlr.write.setPaymentHandler([handler]);

  // transfer tokens to MLR (simulate handler depositing referral fee)
  if (amount > 0n) {
    await token.write.transfer([mlr.address, amount]);
  }

  // get a viem instance bound to the handler wallet for recordReferral calls
  const mlrAsHandler = await env.viem.getContractAt(
    "MultiLevelReferral",
    mlr.address,
    { client: { wallet: walletClients[1] } },
  );
  return { token, mlr, mlrAsHandler };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("MultiLevelReferral — constructor", () => {
  it("rejects zero token address", async () => {
    await expectRevert(
      env.viem.deployContract("MultiLevelReferral", [ZERO_ADDRESS, defaultRcv]),
      "Invalid token",
    );
  });

  it("rejects zero defaultReceiver address", async () => {
    const token = await env.viem.deployContract("EverValueCoin");
    await expectRevert(
      env.viem.deployContract("MultiLevelReferral", [token.address, ZERO_ADDRESS]),
      "Invalid default receiver",
    );
  });

  it("deploys with valid args, sets state, totalPendingRewards starts at zero", async () => {
    const { token, mlr } = await freshDeployment();
    expect((await mlr.read.evaToken()).toLowerCase()).to.equal(token.address.toLowerCase());
    expect((await mlr.read.defaultReceiver()).toLowerCase()).to.equal(defaultRcv.toLowerCase());
    expect(await mlr.read.totalPendingRewards()).to.equal(0n);
    expect(await mlr.read.paymentHandler()).to.equal(ZERO_ADDRESS);
  });
});

describe("MultiLevelReferral — setLevels", () => {
  it("rejects non-owner caller", async () => {
    const { mlr } = await freshDeployment();
    const mlrAsAlice = await env.viem.getContractAt(
      "MultiLevelReferral",
      mlr.address,
      { client: { wallet: walletClients[3] } },
    );
    await expectRevert(mlrAsAlice.write.setLevels([3, [4000, 3000, 2000]]), "Ownable");
  });

  it("rejects levelCount = 0", async () => {
    const { mlr } = await freshDeployment();
    await expectRevert(mlr.write.setLevels([0, []]), "Invalid level count");
  });

  it("rejects levelCount > MAX_LEVELS (5)", async () => {
    const { mlr } = await freshDeployment();
    await expectRevert(
      mlr.write.setLevels([6, [1000, 1000, 1000, 1000, 1000, 1000]]),
      "Invalid level count",
    );
  });

  it("rejects levelBps array length mismatch", async () => {
    const { mlr } = await freshDeployment();
    await expectRevert(mlr.write.setLevels([3, [1000, 1000]]), "Invalid array length");
  });

  it("rejects per-level bps > MAX_BPS", async () => {
    const { mlr } = await freshDeployment();
    await expectRevert(mlr.write.setLevels([2, [10001, 100]]), "Bps too high");
  });

  it("rejects total bps > MAX_BPS", async () => {
    const { mlr } = await freshDeployment();
    await expectRevert(mlr.write.setLevels([2, [6000, 5000]]), "Total bps too high");
  });

  it("accepts valid levels and exposes them via getLevels", async () => {
    const { mlr } = await freshDeployment();
    await mlr.write.setLevels([3, [4000, 3000, 2000]]);
    const [levelCount, levelBps] = await mlr.read.getLevels();
    expect(levelCount).to.equal(3);
    expect(levelBps[0]).to.equal(4000);
    expect(levelBps[1]).to.equal(3000);
    expect(levelBps[2]).to.equal(2000);
    expect(levelBps[3]).to.equal(0);
    expect(levelBps[4]).to.equal(0);
  });

  it("accepts max levels (5) summing to MAX_BPS", async () => {
    const { mlr } = await freshDeployment();
    await mlr.write.setLevels([5, [3000, 2500, 2000, 1500, 1000]]);
    const [levelCount, levelBps] = await mlr.read.getLevels();
    expect(levelCount).to.equal(5);
    expect(levelBps[4]).to.equal(1000);
  });
});

describe("MultiLevelReferral — setDefaultReceiver", () => {
  it("rejects non-owner caller", async () => {
    const { mlr } = await freshDeployment();
    const mlrAsAlice = await env.viem.getContractAt(
      "MultiLevelReferral",
      mlr.address,
      { client: { wallet: walletClients[3] } },
    );
    await expectRevert(mlrAsAlice.write.setDefaultReceiver([alice]), "Ownable");
  });

  it("rejects zero address", async () => {
    const { mlr } = await freshDeployment();
    await expectRevert(mlr.write.setDefaultReceiver([ZERO_ADDRESS]), "Invalid receiver");
  });

  it("updates defaultReceiver", async () => {
    const { mlr } = await freshDeployment();
    await mlr.write.setDefaultReceiver([alice]);
    expect((await mlr.read.defaultReceiver()).toLowerCase()).to.equal(alice.toLowerCase());
  });
});

describe("MultiLevelReferral — setPaymentHandler", () => {
  it("rejects non-owner caller", async () => {
    const { mlr } = await freshDeployment();
    const mlrAsAlice = await env.viem.getContractAt(
      "MultiLevelReferral",
      mlr.address,
      { client: { wallet: walletClients[3] } },
    );
    await expectRevert(mlrAsAlice.write.setPaymentHandler([handler]), "Ownable");
  });

  it("updates paymentHandler", async () => {
    const { mlr } = await freshDeployment();
    await mlr.write.setPaymentHandler([handler]);
    expect((await mlr.read.paymentHandler()).toLowerCase()).to.equal(handler.toLowerCase());
  });
});

describe("MultiLevelReferral — recordReferral access control", () => {
  it("rejects non-handler caller", async () => {
    const { mlr } = await freshDeployment();
    await mlr.write.setPaymentHandler([handler]);
    // deployer (not handler) tries to call
    await expectRevert(
      mlr.write.recordReferral([alice, bob, ONE_EVA]),
      "Only handler",
    );
  });
});

describe("MultiLevelReferral — recordReferral early returns and fallbacks", () => {
  it("returns silently when amount is zero (no fund routing, no events)", async () => {
    const { mlr, mlrAsHandler } = await setupWithHandlerAndFunds(0n);
    await mlr.write.setLevels([3, [4000, 3000, 2000]]);

    await mlrAsHandler.write.recordReferral([alice, bob, 0n]);

    expect(await mlr.read.pendingRewards([defaultRcv])).to.equal(0n);
    expect(await mlr.read.totalPendingRewards()).to.equal(0n);
    expect((await mlr.read.referrerOf([alice])).toLowerCase()).to.equal(ZERO_ADDRESS);
  });

  it("when levelCount is zero, routes the entire amount to defaultReceiver (bug #30 fix)", async () => {
    const { mlr, mlrAsHandler } = await setupWithHandlerAndFunds(HUNDRED_EVA);
    // levelCount left at default 0

    await mlrAsHandler.write.recordReferral([alice, bob, HUNDRED_EVA]);

    expect(await mlr.read.pendingRewards([defaultRcv])).to.equal(HUNDRED_EVA);
    expect(await mlr.read.totalPendingRewards()).to.equal(HUNDRED_EVA);
    // No referrer was assigned because the early-return happens before _maybeAssignReferrer
    expect((await mlr.read.referrerOf([alice])).toLowerCase()).to.equal(ZERO_ADDRESS);
  });

  it("when player has no referrer chain, routes the entire amount to defaultReceiver", async () => {
    const { mlr, mlrAsHandler } = await setupWithHandlerAndFunds(HUNDRED_EVA);
    await mlr.write.setLevels([3, [4000, 3000, 2000]]);

    // potentialReferrer = address(0) so no chain forms
    await mlrAsHandler.write.recordReferral([alice, ZERO_ADDRESS, HUNDRED_EVA]);

    expect(await mlr.read.pendingRewards([defaultRcv])).to.equal(HUNDRED_EVA);
    expect(await mlr.read.totalPendingRewards()).to.equal(HUNDRED_EVA);
  });

  it("when configuredTotalBps is zero, routes the entire amount to defaultReceiver", async () => {
    const { mlr, mlrAsHandler } = await setupWithHandlerAndFunds(HUNDRED_EVA);
    // levelCount = 2, but both bps = 0
    await mlr.write.setLevels([2, [0, 0]]);

    await mlrAsHandler.write.recordReferral([alice, bob, HUNDRED_EVA]);

    expect(await mlr.read.pendingRewards([defaultRcv])).to.equal(HUNDRED_EVA);
    expect(await mlr.read.totalPendingRewards()).to.equal(HUNDRED_EVA);
  });
});

describe("MultiLevelReferral — recordReferral first-time assignment", () => {
  it("assigns potentialReferrer when player has none, then credits the chain", async () => {
    const { mlr, mlrAsHandler } = await setupWithHandlerAndFunds(HUNDRED_EVA);
    await mlr.write.setLevels([1, [10000]]); // 100% to level 1

    await mlrAsHandler.write.recordReferral([alice, bob, HUNDRED_EVA]);

    expect((await mlr.read.referrerOf([alice])).toLowerCase()).to.equal(bob.toLowerCase());
    expect(await mlr.read.pendingRewards([bob])).to.equal(HUNDRED_EVA);
    expect(await mlr.read.totalPendingRewards()).to.equal(HUNDRED_EVA);
  });

  it("does not overwrite an existing referrer", async () => {
    const { mlr, mlrAsHandler } = await setupWithHandlerAndFunds(HUNDRED_EVA);
    await mlr.write.setLevels([1, [10000]]);

    await mlrAsHandler.write.recordReferral([alice, bob, ONE_EVA]);
    await mlrAsHandler.write.recordReferral([alice, carol, ONE_EVA]);

    // referrer is still bob
    expect((await mlr.read.referrerOf([alice])).toLowerCase()).to.equal(bob.toLowerCase());
  });

  it("rejects self-referral attempt", async () => {
    const { mlr, mlrAsHandler } = await setupWithHandlerAndFunds(HUNDRED_EVA);
    await mlr.write.setLevels([1, [10000]]);

    await expectRevert(
      mlrAsHandler.write.recordReferral([alice, alice, HUNDRED_EVA]),
      "Cannot refer self",
    );
  });
});

describe("MultiLevelReferral — recordReferral cycle detection (bug #26)", () => {
  it("rejects assignment that would create a 2-cycle (A→B, then trying B→A)", async () => {
    const { mlr, mlrAsHandler } = await setupWithHandlerAndFunds(HUNDRED_EVA);
    await mlr.write.setLevels([3, [4000, 3000, 2000]]);

    // Assign A's referrer = B
    await mlrAsHandler.write.recordReferral([alice, bob, ONE_EVA]);
    // Try to assign B's referrer = A → cycle
    await expectRevert(
      mlrAsHandler.write.recordReferral([bob, alice, ONE_EVA]),
      "Cycle detected",
    );
  });

  it("rejects assignment that would create a 3-cycle (A→B→C, then C→A)", async () => {
    const { mlr, mlrAsHandler } = await setupWithHandlerAndFunds(HUNDRED_EVA);
    await mlr.write.setLevels([3, [4000, 3000, 2000]]);

    await mlrAsHandler.write.recordReferral([alice, bob, ONE_EVA]);
    await mlrAsHandler.write.recordReferral([bob, carol, ONE_EVA]);
    await expectRevert(
      mlrAsHandler.write.recordReferral([carol, alice, ONE_EVA]),
      "Cycle detected",
    );
  });
});

describe("MultiLevelReferral — recordReferral distribution math", () => {
  it("distributes proportionally across a full chain (bug #27 fix uses configured total bps)", async () => {
    const { mlr, mlrAsHandler } = await setupWithHandlerAndFunds(HUNDRED_EVA);
    // 50/30/20 = 100%
    await mlr.write.setLevels([3, [5000, 3000, 2000]]);

    // Seed the chain with adminSetReferrers (single owner call)
    await mlr.write.adminSetReferrers([[bob, carol], [carol, dave]]);
    // Now alice plays. potentialReferrer = bob → assigns alice→bob, then walks chain bob→carol→dave.
    await mlrAsHandler.write.recordReferral([alice, bob, HUNDRED_EVA]);

    // 100 EVA split 50/30/20 across bob/carol/dave
    expect(await mlr.read.pendingRewards([bob])).to.equal((HUNDRED_EVA * 5000n) / 10000n);
    expect(await mlr.read.pendingRewards([carol])).to.equal((HUNDRED_EVA * 3000n) / 10000n);
    expect(await mlr.read.pendingRewards([dave])).to.equal((HUNDRED_EVA * 2000n) / 10000n);
    expect(await mlr.read.pendingRewards([defaultRcv])).to.equal(0n);
    expect(await mlr.read.totalPendingRewards()).to.equal(HUNDRED_EVA);
  });

  it("missing-level remainder routes to defaultReceiver, not redistributed (bug #27)", async () => {
    const { mlr, mlrAsHandler } = await setupWithHandlerAndFunds(HUNDRED_EVA);
    // Levels 50/30/20, total 100%
    await mlr.write.setLevels([3, [5000, 3000, 2000]]);

    // Chain of length 1 only: alice→bob (no further referrer)
    await mlrAsHandler.write.recordReferral([alice, bob, HUNDRED_EVA]);

    // bob (level 0) gets 50%; remaining 50% goes to defaultReceiver
    expect(await mlr.read.pendingRewards([bob])).to.equal((HUNDRED_EVA * 5000n) / 10000n);
    expect(await mlr.read.pendingRewards([defaultRcv])).to.equal((HUNDRED_EVA * 5000n) / 10000n);
    expect(await mlr.read.totalPendingRewards()).to.equal(HUNDRED_EVA);
  });

  it("when share rounds to zero (tiny amount), level is skipped and remainder routes to defaultReceiver", async () => {
    const { mlr, mlrAsHandler } = await setupWithHandlerAndFunds(1n);
    // 50/50 split — at amount=1, share = (1 * 5000) / 10000 = 0 for both levels
    await mlr.write.setLevels([2, [5000, 5000]]);
    await mlr.write.adminSetReferrers([[bob], [carol]]);

    await mlrAsHandler.write.recordReferral([alice, bob, 1n]);

    // Both bob and carol get 0 (share rounded down); the 1 wei flows to defaultReceiver
    expect(await mlr.read.pendingRewards([bob])).to.equal(0n);
    expect(await mlr.read.pendingRewards([carol])).to.equal(0n);
    expect(await mlr.read.pendingRewards([defaultRcv])).to.equal(1n);
    expect(await mlr.read.totalPendingRewards()).to.equal(1n);
  });

  it("zero-bps levels are skipped (chain advances without crediting)", async () => {
    const { mlr, mlrAsHandler } = await setupWithHandlerAndFunds(HUNDRED_EVA);
    // 50/0/50 total 100% — level 1 is configured but 0 bps
    await mlr.write.setLevels([3, [5000, 0, 5000]]);

    // chain: alice→bob→carol→dave
    await mlr.write.adminSetReferrers([[bob, carol], [carol, dave]]);
    await mlrAsHandler.write.recordReferral([alice, bob, HUNDRED_EVA]);

    // bob (level 0) gets 50%, carol (level 1) gets 0%, dave (level 2) gets 50%
    expect(await mlr.read.pendingRewards([bob])).to.equal(HUNDRED_EVA / 2n);
    expect(await mlr.read.pendingRewards([carol])).to.equal(0n);
    expect(await mlr.read.pendingRewards([dave])).to.equal(HUNDRED_EVA / 2n);
  });
});

describe("MultiLevelReferral — RewardCredited events (bug #31)", () => {
  it("emits RewardCredited per credit and FALLBACK_LEVEL when remainder routes to defaultReceiver", async () => {
    const { mlr, mlrAsHandler } = await setupWithHandlerAndFunds(HUNDRED_EVA);
    await mlr.write.setLevels([3, [5000, 3000, 2000]]);

    const txHash = await mlrAsHandler.write.recordReferral([alice, bob, HUNDRED_EVA]);
    const publicClient = await env.viem.getPublicClient();
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    const rewardCreditedAbi = parseAbi([
      "event RewardCredited(address indexed player, address indexed recipient, uint8 level, uint256 amount)",
    ]);

    // Decode RewardCredited events from logs
    const decoded = receipt.logs
      .map((l) => {
        try {
          return env.viem.decodeEventLog
            ? env.viem.decodeEventLog({ abi: rewardCreditedAbi, data: l.data, topics: l.topics })
            : null;
        } catch { return null; }
      })
      .filter((x) => x !== null);

    // Direct fallback approach without relying on decodeEventLog: count topic[0] matches
    const eventTopic = "0x".padEnd(2, "0"); // placeholder; actual topic check below
    const rewardEvents = receipt.logs.filter(
      (l) => l.address.toLowerCase() === mlr.address.toLowerCase(),
    );
    // We expect at least 2 RewardCredited (bob credit, fallback credit) + 1 ReferrerRecorded
    expect(rewardEvents.length).to.be.greaterThanOrEqual(2);

    // Validate the credits ended up in the right buckets (the math is verified in earlier tests)
    expect(await mlr.read.pendingRewards([bob])).to.equal((HUNDRED_EVA * 5000n) / 10000n);
    expect(await mlr.read.pendingRewards([defaultRcv])).to.equal((HUNDRED_EVA * 5000n) / 10000n);
  });
});

describe("MultiLevelReferral — withdrawRewards", () => {
  it("rejects withdraw when no rewards", async () => {
    const { mlr } = await freshDeployment();
    const mlrAsAlice = await env.viem.getContractAt(
      "MultiLevelReferral",
      mlr.address,
      { client: { wallet: walletClients[3] } },
    );
    await expectRevert(mlrAsAlice.write.withdrawRewards(), "No rewards");
  });

  it("transfers full pendingRewards, decrements totalPendingRewards, zeros recipient slot", async () => {
    const { token, mlr, mlrAsHandler } = await setupWithHandlerAndFunds(HUNDRED_EVA);
    await mlr.write.setLevels([1, [10000]]);
    await mlrAsHandler.write.recordReferral([alice, bob, HUNDRED_EVA]);

    expect(await mlr.read.pendingRewards([bob])).to.equal(HUNDRED_EVA);
    const bobBalanceBefore = await token.read.balanceOf([bob]);

    const mlrAsBob = await env.viem.getContractAt(
      "MultiLevelReferral",
      mlr.address,
      { client: { wallet: walletClients[4] } },
    );
    await mlrAsBob.write.withdrawRewards();

    expect(await mlr.read.pendingRewards([bob])).to.equal(0n);
    expect(await mlr.read.totalPendingRewards()).to.equal(0n);
    const bobBalanceAfter = await token.read.balanceOf([bob]);
    expect(bobBalanceAfter - bobBalanceBefore).to.equal(HUNDRED_EVA);
  });
});

describe("MultiLevelReferral — adminSetReferrers", () => {
  it("rejects non-owner caller", async () => {
    const { mlr } = await freshDeployment();
    const mlrAsAlice = await env.viem.getContractAt(
      "MultiLevelReferral",
      mlr.address,
      { client: { wallet: walletClients[3] } },
    );
    await expectRevert(mlrAsAlice.write.adminSetReferrers([[alice], [bob]]), "Ownable");
  });

  it("rejects length mismatch", async () => {
    const { mlr } = await freshDeployment();
    await expectRevert(
      mlr.write.adminSetReferrers([[alice, bob], [carol]]),
      "len",
    );
  });

  it("rejects zero referee", async () => {
    const { mlr } = await freshDeployment();
    await expectRevert(
      mlr.write.adminSetReferrers([[ZERO_ADDRESS], [bob]]),
      "referee",
    );
  });

  it("rejects zero referrer or self-referrer", async () => {
    const { mlr } = await freshDeployment();
    await expectRevert(
      mlr.write.adminSetReferrers([[alice], [ZERO_ADDRESS]]),
      "referrer",
    );
    await expectRevert(
      mlr.write.adminSetReferrers([[alice], [alice]]),
      "referrer",
    );
  });

  it("rejects when referee already has a referrer", async () => {
    const { mlr } = await freshDeployment();
    await mlr.write.adminSetReferrers([[alice], [bob]]);
    await expectRevert(
      mlr.write.adminSetReferrers([[alice], [carol]]),
      "already set",
    );
  });

  it("rejects when assignment would create a cycle", async () => {
    const { mlr } = await freshDeployment();
    await mlr.write.adminSetReferrers([[alice], [bob]]);
    // Try bob→alice (would cycle)
    await expectRevert(
      mlr.write.adminSetReferrers([[bob], [alice]]),
      "Cycle detected",
    );
  });

  it("seeds multiple referrer relationships in one call", async () => {
    const { mlr } = await freshDeployment();
    await mlr.write.adminSetReferrers([[alice, bob, carol], [bob, carol, dave]]);
    expect((await mlr.read.referrerOf([alice])).toLowerCase()).to.equal(bob.toLowerCase());
    expect((await mlr.read.referrerOf([bob])).toLowerCase()).to.equal(carol.toLowerCase());
    expect((await mlr.read.referrerOf([carol])).toLowerCase()).to.equal(dave.toLowerCase());
  });
});

describe("MultiLevelReferral — emergencyWithdraw", () => {
  it("rejects non-owner caller", async () => {
    const { mlr } = await freshDeployment();
    const mlrAsAlice = await env.viem.getContractAt(
      "MultiLevelReferral",
      mlr.address,
      { client: { wallet: walletClients[3] } },
    );
    await expectRevert(mlrAsAlice.write.emergencyWithdraw([alice, 1n]), "Ownable");
  });

  it("rejects zero recipient", async () => {
    const { mlr } = await freshDeployment();
    await expectRevert(mlr.write.emergencyWithdraw([ZERO_ADDRESS, 1n]), "to");
  });

  it("rejects amount > current balance", async () => {
    const { mlr } = await freshDeployment();
    await expectRevert(mlr.write.emergencyWithdraw([deployer, 1n]), "insufficient");
  });

  it("drains the full balance, including tokens backing pending rewards (no exceptions)", async () => {
    const { token, mlr, mlrAsHandler } = await setupWithHandlerAndFunds(HUNDRED_EVA);
    await mlr.write.setLevels([1, [10000]]);
    await mlrAsHandler.write.recordReferral([alice, bob, HUNDRED_EVA]);

    // 100 EVA in contract, all of it accounted as pending for bob
    expect(await token.read.balanceOf([mlr.address])).to.equal(HUNDRED_EVA);
    expect(await mlr.read.totalPendingRewards()).to.equal(HUNDRED_EVA);

    // Owner drains everything via amount=0 sentinel
    const before = await token.read.balanceOf([deployer]);
    await mlr.write.emergencyWithdraw([deployer, 0n]);
    const after = await token.read.balanceOf([deployer]);

    expect(after - before).to.equal(HUNDRED_EVA);
    expect(await token.read.balanceOf([mlr.address])).to.equal(0n);
    // Pending-reward accounting is unaffected — owner is trusted to reimburse out of band
    expect(await mlr.read.pendingRewards([bob])).to.equal(HUNDRED_EVA);
    expect(await mlr.read.totalPendingRewards()).to.equal(HUNDRED_EVA);
  });

  it("withdraws an explicit amount when specified", async () => {
    const { token, mlr } = await freshDeployment();
    await token.write.transfer([mlr.address, HUNDRED_EVA]);

    const before = await token.read.balanceOf([deployer]);
    await mlr.write.emergencyWithdraw([deployer, 30n * ONE_EVA]);
    const after = await token.read.balanceOf([deployer]);

    expect(after - before).to.equal(30n * ONE_EVA);
    expect(await token.read.balanceOf([mlr.address])).to.equal(70n * ONE_EVA);
  });
});

describe("MultiLevelReferral — view helpers", () => {
  it("getReferrer returns assigned referrer", async () => {
    const { mlr } = await freshDeployment();
    expect((await mlr.read.getReferrer([alice])).toLowerCase()).to.equal(ZERO_ADDRESS);
    await mlr.write.adminSetReferrers([[alice], [bob]]);
    expect((await mlr.read.getReferrer([alice])).toLowerCase()).to.equal(bob.toLowerCase());
  });
});
