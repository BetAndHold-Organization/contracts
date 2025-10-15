import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { parseEther } from "viem";
import type { Hex } from "viem";

import type { ContractReturnType } from "@nomicfoundation/hardhat-viem/types";

type HardhatConnection = Awaited<ReturnType<typeof network.connect>>;
type ViemHelpers = HardhatConnection["viem"];
type TestClient = Awaited<ReturnType<ViemHelpers["getTestClient"]>>;
type PublicClient = Awaited<ReturnType<ViemHelpers["getPublicClient"]>>;

type EverValueCoinContract = ContractReturnType<"EverValueCoin">;
type PaymentHandlerContract = ContractReturnType<"PaymentHandler">;
type MultiLevelReferralContract = ContractReturnType<"MultiLevelReferral">;
type MockPaymentGameContract = ContractReturnType<"MockPaymentGame">;

type WalletClient = Awaited<ReturnType<ViemHelpers["getWalletClients"]>>[number];

const FIVE_LEVEL_BPS = [7_000, 1_200, 900, 600, 300] as const;
const MAX_BPS = 10_000n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

describe("PaymentHandler + MultiLevelReferral integration", () => {
  let viem: ViemHelpers;
  let publicClient: PublicClient;
  let testClient: TestClient;

  let owner: WalletClient;
  let house: WalletClient;
  let defaultReceiver: WalletClient;
  let extraSigners: WalletClient[];

  let token: EverValueCoinContract;
  let handler: PaymentHandlerContract;
  let referral: MultiLevelReferralContract;
  let game: MockPaymentGameContract;
  let extraGame: MockPaymentGameContract;

  beforeEach(async () => {
    const connection: HardhatConnection = await network.connect();
    viem = connection.viem;
    publicClient = await viem.getPublicClient();
    testClient = await viem.getTestClient();

    [owner, house, defaultReceiver, ...extraSigners] = await viem.getWalletClients();

    token = await viem.deployContract("EverValueCoin");
    referral = await viem.deployContract("MultiLevelReferral", [token.address, owner.account.address]);
    handler = await viem.deployContract("PaymentHandler", [token.address]);
    game = await viem.deployContract("MockPaymentGame", [handler.address, token.address]);
    extraGame = await viem.deployContract("MockPaymentGame", [handler.address, token.address]);

    await handler.write.setReferralContract([referral.address], { account: owner.account });
    await referral.write.setDefaultReceiver([defaultReceiver.account.address], { account: owner.account });

    await assert.rejects(
      () =>
        handler.write.registerGame([
          extraGame.address,
          extraGame.address,
          owner.account.address,
          8_500,
          2_000,
        ], { account: owner.account }),
      (error: unknown) => {
        assert.match(String(error), /Bps overflow/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        handler.write.registerGame([
          extraGame.address,
          ZERO_ADDRESS,
          owner.account.address,
          500,
          500,
        ], { account: owner.account }),
      (error: unknown) => {
        assert.match(String(error), /Invalid payout target/);
        return true;
      }
    );

    await handler.write.registerGame([
      extraGame.address,
      extraGame.address,
      owner.account.address,
      500,
      400,
    ], { account: owner.account });

    await handler.write.updateGameConfig([
      extraGame.address,
      game.address,
      house.account.address,
      200,
      200,
    ], { account: owner.account });

    await handler.write.setGameStatus([extraGame.address, false], { account: owner.account });
    await referral.write.setPaymentHandler([handler.address], { account: owner.account });
    await referral.write.setLevels([FIVE_LEVEL_BPS.length, FIVE_LEVEL_BPS], { account: owner.account });
  });

  async function waitForReceipt(hash: Hex) {
    return publicClient.waitForTransactionReceipt({ hash });
  }

  async function grantAndApprove(wallet: WalletClient, amount: bigint) {
    await token.write.transfer([wallet.account.address, amount], { account: owner.account });
    await token.write.approve([handler.address, amount], { account: wallet.account });
  }

  it("distributes rewards across five levels with partial ladder filling", async () => {
    assert(viem && publicClient && testClient);

    const leader = extraSigners[0];
    const level2 = [extraSigners[1], extraSigners[2]] as const;
    const level3 = [extraSigners[3], extraSigners[4]] as const;
    const level4 = [extraSigners[5], extraSigners[6], extraSigners[7]] as const;
    const level5 = [extraSigners[8], extraSigners[9]] as const;

    const adminTester = extraSigners[10];
    const participants = [leader, ...level2, ...level3, ...level4, ...level5, house, adminTester, defaultReceiver];

    const FUNDING_AMOUNT = parseEther("5");
    for (const wallet of participants) {
      await grantAndApprove(wallet, FUNDING_AMOUNT);
    }

    await handler.write.registerGame([
      game.address,
      game.address,
      house.account.address,
      500,
      1_000,
    ], { account: owner.account });

    const parentMap = new Map<string, string>();
    const canonical = new Map<string, string>();

    function registerAddress(addr: string) {
      canonical.set(addr.toLowerCase(), addr);
    }

    function link(child: WalletClient, parent: WalletClient) {
      parentMap.set(child.account.address.toLowerCase(), parent.account.address.toLowerCase());
    }

    for (const wallet of participants) registerAddress(wallet.account.address);
    registerAddress(owner.account.address);
    registerAddress(referral.address);
    registerAddress(game.address);

    link(level2[0], leader);
    link(level2[1], leader);
    link(level3[0], level2[0]);
    link(level3[1], level2[1]);
    link(level4[0], level3[0]);
    link(level4[1], level3[0]);
    link(level4[2], level3[1]);
    link(level5[0], level4[0]);
    link(level5[1], level4[1]);
    link(adminTester, leader);

    const expectedPending = new Map<string, bigint>();
    const directGenerated = new Map<string, bigint>();
    const defaultReceiverKey = defaultReceiver.account.address.toLowerCase();
    const bpsAsBigInt = FIVE_LEVEL_BPS.map((value) => BigInt(value));

    function addExpected(address: string, amount: bigint) {
      if (amount === 0n) return;
      const key = address.toLowerCase();
      expectedPending.set(key, (expectedPending.get(key) ?? 0n) + amount);
    }

    function getChain(bettor: string) {
      const chain: string[] = [];
      let current = parentMap.get(bettor.toLowerCase());
      let depth = 0;
      while (current && depth < FIVE_LEVEL_BPS.length) {
        chain.push(current);
        current = parentMap.get(current);
        depth += 1;
      }
      return chain;
    }

    function applyDistribution(referralAmount: bigint, bettor: string) {
      const chain = getChain(bettor);
      if (chain.length === 0) {
        addExpected(defaultReceiverKey, referralAmount);
        return;
      }

      const totalBps = chain.reduce((acc, _addr, idx) => acc + bpsAsBigInt[idx], 0n);
      let remaining = referralAmount;
      for (let i = 0; i < chain.length; i += 1) {
        const recipient = chain[i];
        let share: bigint;
        if (i === chain.length - 1) {
          share = remaining;
        } else {
          share = (referralAmount * bpsAsBigInt[i]) / totalBps;
          if (share > remaining) share = remaining;
          remaining -= share;
        }
        addExpected(recipient, share);
      }
    }

    const HOUSE_BPS = 500n;
    const REFERRAL_BPS = 1_000n;
    let expectedReferralPool = 0n;
    let expectedNetToGame = 0n;

    async function executeBet(bettor: WalletClient, baseCost: bigint, potentialReferrer?: WalletClient | null) {
      const houseFee = (baseCost * HOUSE_BPS) / MAX_BPS;
      const referralFee = (baseCost * REFERRAL_BPS) / MAX_BPS;
      const netAmount = baseCost - houseFee - referralFee;

      expectedReferralPool += referralFee;
      expectedNetToGame += netAmount;

      if (potentialReferrer) {
        const parentKey = potentialReferrer.account.address.toLowerCase();
        directGenerated.set(parentKey, (directGenerated.get(parentKey) ?? 0n) + referralFee);
      }

      const tx = await game.write.placeBet([
        bettor.account.address,
        potentialReferrer ? potentialReferrer.account.address : ZERO_ADDRESS,
        baseCost,
      ], { account: bettor.account });
      await waitForReceipt(tx);

      applyDistribution(referralFee, bettor.account.address);
    }

    const setupBet = parseEther("0.1");
    await executeBet(level2[0], setupBet, leader);
    await executeBet(level2[1], setupBet, leader);
    await executeBet(level3[0], setupBet, level2[0]);
    await executeBet(level3[1], setupBet, level2[1]);
    await executeBet(level4[0], setupBet, level3[0]);
    await executeBet(level4[1], setupBet, level3[0]);
    await executeBet(level4[2], setupBet, level3[1]);

    const mainBet = parseEther("1");
    await executeBet(level5[0], mainBet, level4[0]);
    await executeBet(level5[0], mainBet, level4[0]);
    await executeBet(level5[0], mainBet, level4[0]);
    await executeBet(level5[1], mainBet, level4[1]);
    await executeBet(level5[1], mainBet, level4[1]);
    await executeBet(level4[2], mainBet, level3[1]);

    await executeBet(house, mainBet, null);
    await executeBet(adminTester, mainBet, leader);

    const referralBalance = await token.read.balanceOf([referral.address]);
    assert.equal(referralBalance, expectedReferralPool);

    const gameBalance = await token.read.balanceOf([game.address]);
    assert.equal(gameBalance, expectedNetToGame);

    const pendingChecks: Array<[string, bigint]> = [];
    for (const [key, amount] of expectedPending.entries()) {
      const canonicalAddr = canonical.get(key);
      assert(canonicalAddr, "address missing");
      const pending = await referral.read.pendingRewards([canonicalAddr]);
      assert.equal(pending, amount, `pending mismatch for ${canonicalAddr}`);
    }

    for (const [parentKey, generated] of directGenerated.entries()) {
      const canonicalAddr = canonical.get(parentKey);
      assert(canonicalAddr, "direct parent missing");
      const expectedShare = expectedPending.get(parentKey) ?? 0n;
      const minAllowed = (generated * BigInt(FIVE_LEVEL_BPS[0])) / MAX_BPS;
      assert(
        expectedShare >= minAllowed,
        `direct referrer share below minimum for ${canonicalAddr}`
      );
    }

    const withdrawers = [level4[0], owner];
    for (const wallet of withdrawers) {
      const key = wallet.account.address.toLowerCase();
      const pendingAmount = expectedPending.get(key) ?? 0n;
      if (pendingAmount === 0n) continue;

      const balanceBefore = await token.read.balanceOf([wallet.account.address]);
      const tx = await referral.write.withdrawRewards([], { account: wallet.account });
      await waitForReceipt(tx);
      const balanceAfter = await token.read.balanceOf([wallet.account.address]);
      assert.equal(balanceAfter - balanceBefore, pendingAmount);
      expectedReferralPool -= pendingAmount;
      expectedPending.set(key, 0n);
      const updatedPending = await referral.read.pendingRewards([wallet.account.address]);
      assert.equal(updatedPending, 0n);
    }

    const finalReferralBalance = await token.read.balanceOf([referral.address]);
    assert.equal(finalReferralBalance, expectedReferralPool);

    const unregisteredGame = await viem.deployContract("MockPaymentGame", [handler.address, token.address]);

    await assert.rejects(
      () =>
        unregisteredGame.write.placeBet([
          adminTester.account.address,
          ZERO_ADDRESS,
          parseEther("0.1"),
        ], { account: adminTester.account }),
      (error: unknown) => {
        assert.match(String(error), /Game not registered/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        extraGame.write.placeBet([
          adminTester.account.address,
          ZERO_ADDRESS,
          parseEther("0.1"),
        ], { account: adminTester.account }),
      (error: unknown) => {
        assert.match(String(error), /Game disabled/);
        return true;
      }
    );

    await handler.write.updateGameConfig([
      game.address,
      referral.address,
      owner.account.address,
      400,
      900,
    ], { account: owner.account });

    const [enabledAfter, payoutTargetAfter, feeRecipientAfter, houseEdgeAfter, referralBpsAfter] =
      await handler.read.getGameConfig([game.address]);
    assert.equal(enabledAfter, true);
    assert.equal(payoutTargetAfter.toLowerCase(), referral.address.toLowerCase());
    assert.equal(feeRecipientAfter.toLowerCase(), owner.account.address.toLowerCase());
    assert.equal(houseEdgeAfter, 400);
    assert.equal(referralBpsAfter, 900);

    await handler.write.setGameStatus([game.address, false], { account: owner.account });
    await assert.rejects(
      () =>
        game.write.placeBet([
          adminTester.account.address,
          ZERO_ADDRESS,
          parseEther("0.1"),
        ], { account: adminTester.account }),
      (error: unknown) => {
        assert.match(String(error), /Game disabled/);
        return true;
      }
    );
    await handler.write.setGameStatus([game.address, true], { account: owner.account });

    await assert.rejects(
      () =>
        game.write.placeBet([
          adminTester.account.address,
          ZERO_ADDRESS,
          0n,
        ], { account: adminTester.account }),
      (error: unknown) => {
        assert.match(String(error), /Amount must be positive/);
        return true;
      }
    );

    await handler.write.setReferralContract([ZERO_ADDRESS], { account: owner.account });
    await assert.rejects(
      () =>
        game.write.placeBet([
          adminTester.account.address,
          ZERO_ADDRESS,
          parseEther("0.1"),
        ], { account: adminTester.account }),
      (error: unknown) => {
        assert.match(String(error), /Referral contract not set/);
        return true;
      }
    );
    await handler.write.setReferralContract([referral.address], { account: owner.account });
  });



  it("exercises _maybeAssignReferrer edge branches", async () => {
    assert(viem && publicClient && testClient);

    await referral.write.setPaymentHandler([owner.account.address], { account: owner.account });
    await referral.write.setDefaultReceiver([house.account.address], { account: owner.account });
    const [playerZeroRef, refCandidate, existingReferrer, freshPlayer] = extraSigners.slice(10, 14);

    const ladder = [6_000, 3_000, 700, 200, 100];
    await referral.write.setLevels([ladder.length, ladder], { account: owner.account });

    const fallbackBeforeZeroPlayer = await referral.read.pendingRewards([house.account.address]);
    await referral.write.recordReferral([ZERO_ADDRESS, refCandidate.account.address, 25n], {
      account: owner.account,
    });
    const fallbackAfterZeroPlayer = await referral.read.pendingRewards([house.account.address]);
    assert.equal(fallbackAfterZeroPlayer - fallbackBeforeZeroPlayer, 25n);
    assert.equal(await referral.read.referrerOf([ZERO_ADDRESS]), ZERO_ADDRESS);

    // potentialReferrer == zero should credit entire amount to fallback
    const fallbackBeforeZeroRef = await referral.read.pendingRewards([house.account.address]);
    await referral.write.recordReferral([playerZeroRef.account.address, ZERO_ADDRESS, 15n], {
      account: owner.account,
    });
    const fallbackAfterZeroRef = await referral.read.pendingRewards([house.account.address]);
    assert.equal(fallbackAfterZeroRef - fallbackBeforeZeroRef, 15n);
    assert.equal(await referral.read.referrerOf([playerZeroRef.account.address]), ZERO_ADDRESS);

    const firstReferralAmount = 100_000n;
    await referral.write.recordReferral([playerZeroRef.account.address, refCandidate.account.address, firstReferralAmount], {
      account: owner.account,
    });

    await referral.write.recordReferral([playerZeroRef.account.address, existingReferrer.account.address, 50_000n], {
      account: owner.account,
    });
    assert.equal(
      (await referral.read.referrerOf([playerZeroRef.account.address])).toLowerCase(),
      refCandidate.account.address.toLowerCase()
    );
    assert.equal(await referral.read.pendingRewards([existingReferrer.account.address]), 0n);

    const secondReferralAmount = 10_000n;
    await referral.write.recordReferral([freshPlayer.account.address, refCandidate.account.address, secondReferralAmount], {
      account: owner.account,
    });

    const expectedRewards = new Map<string, bigint>();
    expectedRewards.set(house.account.address.toLowerCase(), fallbackAfterZeroRef);
    function addReward(recipient: string, amount: bigint) {
      const key = recipient.toLowerCase();
      expectedRewards.set(key, (expectedRewards.get(key) ?? 0n) + amount);
    }

    function runDistribution(player: string, referrer: string, amount: bigint) {
      const chain: string[] = [];
      let current = referrer;
      for (let depth = 0; depth < ladder.length && current !== ZERO_ADDRESS; depth += 1) {
        chain.push(current);
        current = relationMemory.get(current) ?? ZERO_ADDRESS;
      }

      if (chain.length === 0) {
        addReward(house.account.address, amount);
        return;
      }

      let remaining = amount;
      for (let depth = 0; depth < chain.length; depth += 1) {
        const recipient = chain[depth];
        if (depth === chain.length - 1) {
          addReward(recipient, remaining);
          remaining = 0n;
        } else {
          const share = (amount * BigInt(ladder[depth])) / MAX_BPS;
          remaining -= share;
          addReward(recipient, share);
        }
      }

      if (remaining > 0n) {
        addReward(house.account.address, remaining);
      }
    }

    const relationMemory = new Map<string, string>();
    relationMemory.set(playerZeroRef.account.address.toLowerCase(), refCandidate.account.address.toLowerCase());

    runDistribution(playerZeroRef.account.address, refCandidate.account.address, firstReferralAmount);
    runDistribution(playerZeroRef.account.address, refCandidate.account.address, 50_000n);

    relationMemory.set(freshPlayer.account.address.toLowerCase(), refCandidate.account.address.toLowerCase());
    runDistribution(freshPlayer.account.address, refCandidate.account.address, secondReferralAmount);

    const refCandidateRewards = await referral.read.pendingRewards([refCandidate.account.address]);
    assert.equal(refCandidateRewards, expectedRewards.get(refCandidate.account.address.toLowerCase()) ?? 0n);

    const fallbackRewards = await referral.read.pendingRewards([house.account.address]);
    assert.equal(fallbackRewards, expectedRewards.get(house.account.address.toLowerCase()) ?? 0n);

    await assert.rejects(
      () =>
        referral.write.recordReferral([refCandidate.account.address, refCandidate.account.address, 1n], {
          account: owner.account,
        }),
      (error: unknown) => {
        assert.match(String(error), /Cannot refer self/);
        return true;
      }
    );
  });

  it("covers zero-level and owner-fallback branches", async () => {
    assert(viem && publicClient && testClient);

    await referral.write.setPaymentHandler([owner.account.address], { account: owner.account });

    const [player, refA, refB] = extraSigners.slice(11, 14);

    const ownerPendingStart = await referral.read.pendingRewards([owner.account.address]);
    await referral.write.recordReferral([player.account.address, refA.account.address, 200n], {
      account: owner.account,
    });
    assert.equal(
      (await referral.read.referrerOf([player.account.address])).toLowerCase(),
      refA.account.address.toLowerCase()
    );
    const ownerPendingAfterEarly = await referral.read.pendingRewards([owner.account.address]);
    assert.equal(ownerPendingAfterEarly - ownerPendingStart, 0n);

    await referral.write.setDefaultReceiver([ZERO_ADDRESS], { account: owner.account });

    const zeroLevels = [0, 0, 0];
    await referral.write.setLevels([zeroLevels.length, zeroLevels], { account: owner.account });

    await referral.write.recordReferral([player.account.address, refA.account.address, 0n], {
      account: owner.account,
    });
    assert.equal(
      (await referral.read.referrerOf([player.account.address])).toLowerCase(),
      refA.account.address.toLowerCase()
    );

    const ownerBeforeFallback = await referral.read.pendingRewards([owner.account.address]);
    await referral.write.recordReferral([player.account.address, refA.account.address, 500n], {
      account: owner.account,
    });
    const ownerAfterFallback = await referral.read.pendingRewards([owner.account.address]);
    assert.equal(ownerAfterFallback - ownerBeforeFallback, 500n);
    assert.equal(
      (await referral.read.referrerOf([player.account.address])).toLowerCase(),
      refA.account.address.toLowerCase()
    );

    const shareLevels = [9_000, 1_000];
    await referral.write.setLevels([shareLevels.length, shareLevels], { account: owner.account });

    await referral.write.recordReferral([refA.account.address, refB.account.address, 2n], {
      account: owner.account,
    });

    const refAPendingBefore = await referral.read.pendingRewards([refA.account.address]);
    const refBPendingBefore = await referral.read.pendingRewards([refB.account.address]);
    const ownerBeforeShare = await referral.read.pendingRewards([owner.account.address]);

    await referral.write.recordReferral([player.account.address, refA.account.address, 1n], {
      account: owner.account,
    });

    const refAPendingAfter = await referral.read.pendingRewards([refA.account.address]);
    const refBPendingAfter = await referral.read.pendingRewards([refB.account.address]);
    const ownerAfterShare = await referral.read.pendingRewards([owner.account.address]);

    assert.equal(refAPendingAfter - refAPendingBefore, 0n);
    assert.equal(refBPendingAfter - refBPendingBefore, 1n);
    assert.equal(ownerAfterShare, ownerBeforeShare);

    await referral.write.setDefaultReceiver([defaultReceiver.account.address], { account: owner.account });

    const defaultReceiverBefore = await referral.read.pendingRewards([defaultReceiver.account.address]);
    await referral.write.recordReferral([player.account.address, refA.account.address, 200n], {
      account: owner.account,
    });
    const defaultReceiverAfter = await referral.read.pendingRewards([defaultReceiver.account.address]);
    assert.equal(defaultReceiverAfter - defaultReceiverBefore, 0n);
  });

  it("does nothing when level count is zero", async () => {
    assert(viem && publicClient && testClient);

    await referral.write.setPaymentHandler([owner.account.address], { account: owner.account });

    const [player, refA] = extraSigners.slice(14, 16);

    const ownerBefore = await referral.read.pendingRewards([owner.account.address]);
    const defaultReceiverBefore = await referral.read.pendingRewards([defaultReceiver.account.address]);

    assert.equal(await referral.read.referrerOf([player.account.address]), ZERO_ADDRESS);
    assert.equal(await referral.read.pendingRewards([owner.account.address]), ownerBefore);
    assert.equal(await referral.read.pendingRewards([defaultReceiver.account.address]), defaultReceiverBefore);
  });

  it("does nothing when referral amount is zero", async () => {
    assert(viem && publicClient && testClient);

    await referral.write.setPaymentHandler([owner.account.address], { account: owner.account });

    const [player, refA] = extraSigners;

    await referral.write.setLevels([1, [10_000]], { account: owner.account });

    const ownerBefore = await referral.read.pendingRewards([owner.account.address]);
    const defaultReceiverBefore = await referral.read.pendingRewards([defaultReceiver.account.address]);

    await referral.write.recordReferral([player.account.address, refA.account.address, 0n], {
      account: owner.account,
    });

    assert.equal(await referral.read.referrerOf([player.account.address]), ZERO_ADDRESS);
    assert.equal(await referral.read.pendingRewards([owner.account.address]), ownerBefore);
    assert.equal(await referral.read.pendingRewards([defaultReceiver.account.address]), defaultReceiverBefore);
  });

  it("skips zero-share levels", async () => {
    assert(viem && publicClient && testClient);

    await referral.write.setPaymentHandler([owner.account.address], { account: owner.account });

    const [player, refA, refB] = extraSigners.slice(2, 5);

    await referral.write.setLevels([2, [9_999, 1]], { account: owner.account });

    await referral.write.recordReferral([refA.account.address, refB.account.address, 10_000n], {
      account: owner.account,
    });

    const refABefore = await referral.read.pendingRewards([refA.account.address]);
    const refBBefore = await referral.read.pendingRewards([refB.account.address]);

    await referral.write.recordReferral([player.account.address, refA.account.address, 1n], {
      account: owner.account,
    });

    const refAAfter = await referral.read.pendingRewards([refA.account.address]);
    const refBAfter = await referral.read.pendingRewards([refB.account.address]);

    assert.equal(refAAfter - refABefore, 0n);
    assert.equal(refBAfter - refBBefore, 1n);
  });

  it("drops fallback when receiver and owner are zero", async () => {
    assert(viem && publicClient && testClient);

    await referral.write.setPaymentHandler([owner.account.address], { account: owner.account });

    const [player, refA] = extraSigners.slice(5, 7);

    await referral.write.setLevels([1, [10_000]], { account: owner.account });
    await referral.write.setDefaultReceiver([ZERO_ADDRESS], { account: owner.account });

    await referral.write.renounceOwnership({ account: owner.account });

    const ownerBalanceBefore = await referral.read.pendingRewards([owner.account.address]);
    await referral.write.recordReferral([player.account.address, refA.account.address, 100n], {
      account: owner.account,
    });
    assert.equal(await referral.read.owner(), ZERO_ADDRESS);
    assert.equal(await referral.read.pendingRewards([owner.account.address]), ownerBalanceBefore);
  });
});

