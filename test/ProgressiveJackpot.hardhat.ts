import assert from "node:assert/strict";
import console from "node:console";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { encodePacked, keccak256, padHex, parseEther, toHex } from "viem";

import type { AbiEvent } from "viem";
import type { ContractReturnType } from "@nomicfoundation/hardhat-viem/types";
import type { Hex } from "viem";

type HardhatConnection = Awaited<ReturnType<typeof network.connect>>;
type ViemHelpers = HardhatConnection["viem"];

type ProgressiveJackpotContract = ContractReturnType<"ProgressiveJackpot">;
type EverValueCoinContract = ContractReturnType<"EverValueCoin">;
type MockRandomProviderContract = ContractReturnType<"MockJackpotRandomProvider">;
type MockGameHarnessContract = ContractReturnType<"MockGameHarness">;
type PaymentHandlerContract = ContractReturnType<"PaymentHandler">;
type MultiLevelReferralContract = ContractReturnType<"MultiLevelReferral">;

type WalletClient = Awaited<ReturnType<ViemHelpers["getWalletClients"]>>[number];
type PublicClient = Awaited<ReturnType<ViemHelpers["getPublicClient"]>>;

const DEFAULT_OUTCOMES = [
  {
    cumulativeProbability: 2_500n,
    tierAdvance: 1,
    tierResetTo: 0,
    consolationMultiplier: 0,
    awardsTier: true,
  },
  {
    cumulativeProbability: 6_000n,
    tierAdvance: 0,
    tierResetTo: 0,
    consolationMultiplier: 12_000,
    awardsTier: false,
  },
  {
    cumulativeProbability: 9_000n,
    tierAdvance: 0,
    tierResetTo: 0,
    consolationMultiplier: 15_000,
    awardsTier: false,
  },
  {
    cumulativeProbability: 10_000n,
    tierAdvance: 0,
    tierResetTo: 0,
    consolationMultiplier: 0,
    awardsTier: false,
  },
] as const;

const BEAHOLDER_LADDER = [
  {
    prizeMetric: parseEther("1"),
    isTerminal: false,
    isPercent: false,
    fixedBetCost: parseEther("0.05"),
    useDynamicCost: false,
  },
  {
    prizeMetric: parseEther("1.5"),
    isTerminal: false,
    isPercent: false,
    fixedBetCost: parseEther("0.075"),
    useDynamicCost: false,
  },
  {
    prizeMetric: parseEther("2"),
    isTerminal: false,
    isPercent: false,
    fixedBetCost: parseEther("0.1"),
    useDynamicCost: false,
  },
  {
    prizeMetric: parseEther("2.5"),
    isTerminal: false,
    isPercent: false,
    fixedBetCost: parseEther("0.125"),
    useDynamicCost: false,
  },
  {
    prizeMetric: parseEther("3"),
    isTerminal: false,
    isPercent: false,
    fixedBetCost: parseEther("0.15"),
    useDynamicCost: false,
  },
  {
    prizeMetric: parseEther("3.5"),
    isTerminal: false,
    isPercent: false,
    fixedBetCost: parseEther("0.175"),
    useDynamicCost: false,
  },
  {
    prizeMetric: parseEther("4"),
    isTerminal: false,
    isPercent: false,
    fixedBetCost: parseEther("0.2"),
    useDynamicCost: false,
  },
  {
    prizeMetric: parseEther("5"),
    isTerminal: false,
    isPercent: false,
    fixedBetCost: parseEther("0.25"),
    useDynamicCost: false,
  },
  {
    prizeMetric: parseEther("6"),
    isTerminal: true,
    isPercent: false,
    fixedBetCost: parseEther("0.3"),
    useDynamicCost: false,
  },
] as const;

const PROBABILITY_PRECISION = 10_000n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const DIRECT_BET_EVENT: AbiEvent = {
  type: "event",
  name: "DirectBetRequested",
  inputs: [
    { indexed: true, name: "requestId", type: "uint256" },
    { indexed: true, name: "player", type: "address" },
    { indexed: false, name: "amount", type: "uint256" },
    { indexed: false, name: "tierIndex", type: "uint8" },
  ],
  anonymous: false,
};

describe("ProgressiveJackpot (Hardhat + viem)", () => {
  let viem: ViemHelpers;
  let publicClient: PublicClient;
  let owner: WalletClient;
  let secondary: WalletClient;
  let third: WalletClient;
  let house: WalletClient;

  let token: EverValueCoinContract;
  let randomProvider: MockRandomProviderContract;
  let jackpot: ProgressiveJackpotContract;
  let game: MockGameHarnessContract;
  let handler: PaymentHandlerContract;
  let referral: MultiLevelReferralContract;

  beforeEach(async () => {
    ({ viem } = await network.connect());
    publicClient = await viem.getPublicClient();

    [owner, secondary, third, house] = await viem.getWalletClients();

    token = await viem.deployContract("EverValueCoin");
    randomProvider = await viem.deployContract("MockJackpotRandomProvider");
    jackpot = await viem.deployContract("ProgressiveJackpot", [
      token.address,
      randomProvider.address,
    ]);
    handler = await viem.deployContract("PaymentHandler", [token.address]);
    referral = await viem.deployContract("MultiLevelReferral", [token.address, owner.account.address]);
    game = await viem.deployContract("MockGameHarness", [
      jackpot.address,
      token.address,
    ]);
  });

  it("registers ladder and game", async () => {
    await seedLadder();
    await registerDefaultGame();

    const ladder = await jackpot.read.getTierLadder();
    assert.equal(ladder.length, BEAHOLDER_LADDER.length);
    BEAHOLDER_LADDER.forEach((expected, index) => {
      const tier = ladder[index];
      assert.equal(tier.prizeMetric, expected.prizeMetric);
      assert.equal(tier.isTerminal, expected.isTerminal);
      assert.equal(tier.isPercent, expected.isPercent);
      assert.equal(tier.fixedBetCost, expected.fixedBetCost);
      assert.equal(tier.useDynamicCost, expected.useDynamicCost);
    });

    const outcomes = await jackpot.read.getGameOutcomes([game.address]);
    assert.equal(outcomes.length, DEFAULT_OUTCOMES.length);
    assert.equal(outcomes[0].cumulativeProbability, DEFAULT_OUTCOMES[0].cumulativeProbability);
  });

  it("processes entry that awards tier", async () => {
    await seedLadder();
    await registerDefaultGame();
    await contributeFromGame(parseEther("10"));

    await waitForReceipt(
      await game.write.submitEntry(
        [
          secondary.account.address,
          BEAHOLDER_LADDER[0].fixedBetCost,
          1_000n,
        ]
      )
    );

    const state = await jackpot.read.getJackpotState();
    assert.equal(Number(state.nextTierIndex), 1);
    assert.equal(state.totalEntries, 1n);
    assert.equal(state.totalJackpotsWon, 0n);

    const entries = await jackpot.read.getPlayerEntries([secondary.account.address]);
    assert.equal(entries.length, 1);

    const entry = await jackpot.read.getEntry([entries[0]]);
    assert.equal(entry.payout, BEAHOLDER_LADDER[0].prizeMetric);
    assert.equal(Number(entry.outcomeIndex), 0);
  });

  it("pays consolation and tracks totals", async () => {
    await seedLadder();
    await registerDefaultGame();
    await contributeFromGame(parseEther("10"));

    await waitForReceipt(
      await game.write.submitEntry(
        [secondary.account.address, parseEther("2"), 8_000n]
      )
    );

    const state = await jackpot.read.getJackpotState();
    assert.equal(state.totalConsolationPaid, parseEther("3"));
    assert.equal(Number(state.nextTierIndex), 0);

    const entryId = (await jackpot.read.getPlayerEntries([secondary.account.address]))[0];
    const entry = await jackpot.read.getEntry([entryId]);
    assert.equal(entry.payout, parseEther("3"));
    assert.equal(Number(entry.outcomeIndex), 2);
  });

  it("handles insufficient funds when awarding tier", async () => {
    await seedLadder();
    await registerDefaultGame();

    await assert.rejects(
      () =>
        game.write.submitEntry([
          secondary.account.address,
          BEAHOLDER_LADDER[0].fixedBetCost,
          1_000n,
        ]),
      (error: unknown) => {
        assert.match(String(error), /Jackpot underfunded/);
        return true;
      }
    );

    const terminalTier = {
      prizeMetric: parseEther("6"),
      isTerminal: true,
      isPercent: false,
      fixedBetCost: parseEther("0.3"),
      useDynamicCost: false,
    };

    await jackpot.write.setTierLadder([[terminalTier]], {
      account: owner.account,
    });

    await jackpot.write.registerGame([game.address, DEFAULT_OUTCOMES], {
      account: owner.account,
    });

    await contributeFromGame(parseEther("2"));
    const [, , prize] = await jackpot.read.getCurrentTierInfo();
    assert.equal(prize, terminalTier.prizeMetric);

    await assert.rejects(
      () =>
        game.write.submitEntry([
          secondary.account.address,
          terminalTier.prizeMetric,
          1_000n,
        ]),
      (error: unknown) => {
        assert.match(String(error), /Jackpot underfunded/);
        return true;
      }
    );
  });

  it("reverts when registered game has no outcomes", async () => {
    await seedLadder();

    await assert.rejects(
      () =>
        jackpot.write.registerGame([game.address, []], {
          account: owner.account,
        }),
      (error: unknown) => {
        assert.match(String(error), /InvalidProbabilityTable/);
        return true;
      }
    );
  });

  it("reverts during entry when outcome table is cleared after registration", async () => {
    await seedLadder();
    await registerDefaultGame();
    await contributeFromGame(parseEther("5"));

    const testClient = await viem.getTestClient();

    const mappingSlot = 11n;
    const baseSlot = BigInt(
      keccak256(
        encodePacked(
          ["bytes32", "bytes32"],
          [
            padHex(game.address, { size: 32 }),
            padHex(toHex(mappingSlot), { size: 32 }),
          ]
        )
      )
    );
    const outcomesLengthSlot = baseSlot + 1n;

    await testClient.setStorageAt({
      address: jackpot.address,
      index: padHex(toHex(outcomesLengthSlot), { size: 32 }) as Hex,
      value: padHex("0x0", { size: 32 }) as Hex,
    });

    await assert.rejects(
      () =>
        game.write.forwardEntry([
          secondary.account.address,
          parseEther("1"),
          0n,
        ]),
      (error: unknown) => {
        assert.match(String(error), /InvalidProbabilityTable/);
        return true;
      }
    );
  });

  it("reverts when next tier index exceeds configured ladder", async () => {
    await seedLadder();
    await registerDefaultGame();
    await contributeFromGame(parseEther("5"));

    const testClient = await viem.getTestClient();
    const jackpotStateSlot = 4n;

    await testClient.setStorageAt({
      address: jackpot.address,
      index: padHex(toHex(jackpotStateSlot), { size: 32 }) as Hex,
      value: padHex("0x09", { size: 32 }) as Hex,
    });

    const tierCost = BEAHOLDER_LADDER[0].fixedBetCost;
    await assert.rejects(
      () =>
        game.write.forwardEntry([
          secondary.account.address,
          tierCost,
          0n,
        ]),
      (error: unknown) => {
        assert.match(String(error), /Jackpot underfunded/);
        return true;
      }
    );
  });

  it("skips payout transfer when prize amount is zero", async () => {
    await jackpot.write.setTierLadder([
      [
        {
          prizeMetric: 0n,
              isTerminal: false,
              isPercent: false,
          fixedBetCost: parseEther("0.1"),
              useDynamicCost: false,
            },
      ],
    ], {
      account: owner.account,
    });

    await jackpot.write.registerGame([game.address, DEFAULT_OUTCOMES], {
      account: owner.account,
    });

    const playerBalanceBefore = await token.read.balanceOf([
      secondary.account.address,
    ]);
    const jackpotBalanceBefore = await jackpot.read.getJackpotBalance();

    await waitForReceipt(
      await game.write.submitEntry([
        secondary.account.address,
        parseEther("1"),
        0n,
      ])
    );

    const playerBalanceAfter = await token.read.balanceOf([
      secondary.account.address,
    ]);
    const jackpotBalanceAfter = await jackpot.read.getJackpotBalance();

    assert.equal(playerBalanceAfter, playerBalanceBefore);
    assert.equal(jackpotBalanceAfter, jackpotBalanceBefore);
  });

  it("advances and resets ladder correctly", async () => {
    const ladderSubset = BEAHOLDER_LADDER.slice(0, 3).map((tier, index) => ({
      ...tier,
      isTerminal: index === 2,
    }));

    await jackpot.write.setTierLadder([ladderSubset], {
      account: owner.account,
    });

    const outcomes = [
      {
        cumulativeProbability: 4_000n,
        tierAdvance: 1,
        tierResetTo: 0,
        consolationMultiplier: 0,
        awardsTier: true,
      },
      {
        cumulativeProbability: 7_000n,
        tierAdvance: 2,
        tierResetTo: 0,
        consolationMultiplier: 0,
        awardsTier: true,
      },
      {
        cumulativeProbability: 10_000n,
        tierAdvance: 0,
        tierResetTo: 1,
        consolationMultiplier: 0,
        awardsTier: true,
      },
    ] as const;

    await jackpot.write.registerGame([game.address, outcomes]);
    await contributeFromGame(parseEther("10"));

    await waitForReceipt(
      await game.write.submitEntry([
        secondary.account.address,
        ladderSubset[0].fixedBetCost,
        500n,
      ])
    );
    assert.equal(Number((await jackpot.read.getJackpotState()).nextTierIndex), 1);

    await waitForReceipt(
      await game.write.submitEntry([
        secondary.account.address,
        ladderSubset[1].fixedBetCost,
        5_500n,
      ])
    );
    assert.equal(Number((await jackpot.read.getJackpotState()).nextTierIndex), 0);

    await waitForReceipt(
      await game.write.submitEntry([secondary.account.address, 0n, 9_500n])
    );
    assert.equal(Number((await jackpot.read.getJackpotState()).nextTierIndex), 0);
  });

  it("manages game status and registry views", async () => {
    await seedLadder();
    await registerDefaultGame();

    const registerList = await jackpot.read.getRegisteredGames();
    assert.equal(registerList.length, 1);

    await jackpot.write.setGameStatus([game.address, false], {
      account: owner.account,
    });

    await assert.rejects(
      () =>
        game.write.submitEntry([
          secondary.account.address,
          parseEther("1"),
          1_000n,
        ]),
      (error: unknown) => {
        assert.match(String(error), /GameDisabled/);
        return true;
      }
    );

    await jackpot.write.setGameStatus([game.address, true], {
      account: owner.account,
    });

    await contributeFromGame(parseEther("2"));

    await waitForReceipt(
      await game.write.submitEntry([
        secondary.account.address,
        0n,
        500n,
      ])
    );

    // re-register to exercise update branch
    await jackpot.write.registerGame([game.address, DEFAULT_OUTCOMES], {
      account: owner.account,
    });

    const registerListAfter = await jackpot.read.getRegisteredGames();
    assert.equal(registerListAfter.length, 1);
  });

  it("exposes direct bet outcomes and jackpot balance", async () => {
    const balance0 = await jackpot.read.getJackpotBalance();
    assert.equal(balance0, 0n);

    await seedLadder();
    await registerDefaultGame();
    await contributeFromGame(parseEther("3"));

    const balance = await jackpot.read.getJackpotBalance();
    assert.equal(balance, parseEther("3"));

    await jackpot.write.configureDirectBet([true, DEFAULT_OUTCOMES], {
      account: owner.account,
    });

    const storedOutcomes = await jackpot.read.getDirectBetOutcomes();
    assert.equal(storedOutcomes.length, DEFAULT_OUTCOMES.length);
    DEFAULT_OUTCOMES.forEach((expected, index) => {
      const outcome = storedOutcomes[index];
      assert.equal(outcome.cumulativeProbability, expected.cumulativeProbability);
      assert.equal(outcome.tierAdvance, expected.tierAdvance);
      assert.equal(outcome.tierResetTo, expected.tierResetTo);
      assert.equal(outcome.consolationMultiplier, expected.consolationMultiplier);
      assert.equal(outcome.awardsTier, expected.awardsTier);
    });
  });

  it("routes direct bets through the payment handler and splits fees", async () => {
    console.log("owner", owner.account.address);
    console.log("secondary", secondary.account.address);
    console.log("third", third.account.address);
    console.log("house", house.account.address);
    console.log("jackpot", jackpot.address);
    console.log("paymentHandler", handler.address);
    console.log("referral", referral.address);
    console.log("token", token.address);

    await seedLadder();
    await registerDefaultGame();

    await handler.write.setReferralContract([referral.address], {
      account: owner.account,
    });
    await referral.write.setPaymentHandler([handler.address], {
      account: owner.account,
    });
    await referral.write.setLevels([1, [10_000]], {
      account: owner.account,
    });

    await handler.write.registerGame([
      jackpot.address,
      jackpot.address,
      house.account.address,
      500,
      1_000,
    ], {
      account: owner.account,
    });

    await jackpot.write.setPaymentHandler([handler.address], {
      account: owner.account,
    });

    await jackpot.write.configureDirectBet([true, DEFAULT_OUTCOMES], {
      account: owner.account,
    });

    await token.write.transfer([secondary.account.address, parseEther("1")], {
      account: owner.account,
    });
    await token.write.transfer([house.account.address, parseEther("1")], {
      account: owner.account,
    });
    await token.write.transfer([referral.address, parseEther("1")], {
      account: owner.account,
    });

    // seed house so we can detect its delta cleanly
    const houseSeed = parseEther("2");
    await token.write.transfer([house.account.address, houseSeed], {
      account: owner.account,
    });

    await token.write.transfer([jackpot.address, parseEther("10")], {
      account: owner.account,
    });

    await token.write.approve([handler.address, parseEther("1")], {
      account: secondary.account,
    });

    const cost = await jackpot.read.getCurrentDirectBetCost();
    const playerBalanceBefore = await token.read.balanceOf([secondary.account.address]);
    const houseBalanceBefore = await token.read.balanceOf([house.account.address]);
    const referralBalanceBefore = await token.read.balanceOf([referral.address]);
    const jackpotBalanceBefore = await jackpot.read.getJackpotBalance();
    const pendingBefore = await referral.read.pendingRewards([third.account.address]);
    console.log("pendingBefore: ", pendingBefore.toString());
    const txHash = await jackpot.write.placeDirectBet([third.account.address], {
      account: secondary.account,
    });
    await waitForReceipt(txHash);

    const playerBalanceAfter = await token.read.balanceOf([secondary.account.address]);
    const houseBalanceAfter = await token.read.balanceOf([house.account.address]);
    const referralBalanceAfter = await token.read.balanceOf([referral.address]);
    const jackpotBalanceAfter = await jackpot.read.getJackpotBalance();
    const pendingAfter = await referral.read.pendingRewards([third.account.address]);
    console.log("pendingAfter: ", pendingAfter.toString());
    const paidToHouse = houseBalanceAfter - houseBalanceBefore;
    const paidToReferral = referralBalanceAfter - referralBalanceBefore;
    const jackpotIncrease = jackpotBalanceAfter - jackpotBalanceBefore;
    const pendingIncrease = pendingAfter - pendingBefore;
    const playerSpent = playerBalanceBefore - playerBalanceAfter;

    const maxPayout = await jackpot.read.lastDirectBetMaxPayout();
    const houseFee = (cost * 500n) / PROBABILITY_PRECISION;
    const referralFee = (cost * 1_000n) / PROBABILITY_PRECISION;
    console.log({ cost, houseFee, referralFee });
    const expectedNet = cost - houseFee - referralFee;

    assert.equal(paidToHouse, houseFee);
    assert.equal(paidToReferral, referralFee);
    assert.equal(jackpotIncrease, expectedNet);
    assert.equal(playerSpent, cost);
    assert.equal(pendingIncrease, referralFee);

    const requestId = await findRequestId(txHash);
    await waitForReceipt(
      await randomProvider.write.fulfill([
        requestId,
        9_000n,
      ])
    );

    const playerBalanceAfterFulfill = await token.read.balanceOf([secondary.account.address]);
    const houseBalanceAfterFulfill = await token.read.balanceOf([house.account.address]);
    const referralBalanceAfterFulfill = await token.read.balanceOf([referral.address]);
    const jackpotBalanceAfterFulfill = await jackpot.read.getJackpotBalance();
    const pendingAfterFulfill = await referral.read.pendingRewards([third.account.address]);

    assert.equal(playerBalanceAfterFulfill, playerBalanceAfter);
    assert.equal(houseBalanceAfterFulfill, houseBalanceAfter);
    assert.equal(referralBalanceAfterFulfill, referralBalanceAfter);
    assert.equal(jackpotBalanceAfterFulfill, jackpotBalanceAfter);
    assert.equal(pendingAfterFulfill, pendingAfter);

    const secondTx = await jackpot.write.placeDirectBet([third.account.address], {
      account: secondary.account,
    });
    await waitForReceipt(secondTx);

    const secondHouseBefore = houseBalanceAfterFulfill;
    const secondReferralBefore = referralBalanceAfterFulfill;
    const secondJackpotBefore = jackpotBalanceAfterFulfill;
    const secondPlayerBefore = playerBalanceAfterFulfill;
    const secondPendingBefore = pendingAfterFulfill;

    const secondHouseAfter = await token.read.balanceOf([house.account.address]);
    const secondReferralAfter = await token.read.balanceOf([referral.address]);
    const secondJackpotAfter = await jackpot.read.getJackpotBalance();
    const secondPlayerAfter = await token.read.balanceOf([secondary.account.address]);
    const secondPendingAfter = await referral.read.pendingRewards([third.account.address]);

    const maxPayoutSecond = await jackpot.read.lastDirectBetMaxPayout();
    assert.equal(maxPayoutSecond, maxPayout);

    assert.equal(secondHouseAfter - secondHouseBefore, houseFee);
    assert.equal(secondReferralAfter - secondReferralBefore, referralFee);
    assert.equal(secondJackpotAfter - secondJackpotBefore, expectedNet);
    assert.equal(secondPlayerBefore - secondPlayerAfter, cost);
    assert.equal(secondPendingAfter - secondPendingBefore, referralFee);

    const secondRequestId = await findRequestId(secondTx);
    await waitForReceipt(
      await randomProvider.write.fulfill([
        secondRequestId,
        8_000n,
      ])
    );

    const postWinHouse = await token.read.balanceOf([house.account.address]);
    const postWinReferral = await token.read.balanceOf([referral.address]);
    const postWinJackpot = await jackpot.read.getJackpotBalance();
    const postWinPlayer = await token.read.balanceOf([secondary.account.address]);
    const postWinPending = await referral.read.pendingRewards([third.account.address]);

    const consolation = (expectedNet * 15_000n) / PROBABILITY_PRECISION;

    assert.equal(postWinHouse, secondHouseAfter);
    assert.equal(postWinReferral, secondReferralAfter);
    assert.equal(postWinPending, secondPendingAfter);
    assert.equal(postWinJackpot, secondJackpotAfter - consolation);
    assert.equal(postWinPlayer, secondPlayerAfter + consolation);

    const thirdTx = await jackpot.write.placeDirectBet([third.account.address], {
      account: secondary.account,
    });
    await waitForReceipt(thirdTx);

    const thirdHouseBefore = postWinHouse;
    const thirdReferralBefore = postWinReferral;
    const thirdJackpotBefore = postWinJackpot;
    const thirdPlayerBefore = postWinPlayer;
    const thirdPendingBefore = postWinPending;

    const thirdHouseAfter = await token.read.balanceOf([house.account.address]);
    const thirdReferralAfter = await token.read.balanceOf([referral.address]);
    const thirdJackpotAfter = await jackpot.read.getJackpotBalance();
    const thirdPlayerAfter = await token.read.balanceOf([secondary.account.address]);
    const thirdPendingAfter = await referral.read.pendingRewards([third.account.address]);

    assert.equal(thirdHouseAfter - thirdHouseBefore, houseFee);
    assert.equal(thirdReferralAfter - thirdReferralBefore, referralFee);
    assert.equal(thirdJackpotAfter - thirdJackpotBefore, expectedNet);
    assert.equal(thirdPlayerBefore - thirdPlayerAfter, cost);
    assert.equal(thirdPendingAfter - thirdPendingBefore, referralFee);

    const thirdRequestId = await findRequestId(thirdTx);
    await waitForReceipt(
      await randomProvider.write.fulfill([
        thirdRequestId,
        5_000n,
      ])
    );

    const postConsolationHouse = await token.read.balanceOf([house.account.address]);
    const postConsolationReferral = await token.read.balanceOf([referral.address]);
    const postConsolationJackpot = await jackpot.read.getJackpotBalance();
    const postConsolationPlayer = await token.read.balanceOf([secondary.account.address]);
    const postConsolationPending = await referral.read.pendingRewards([third.account.address]);

    const consolation12 = (expectedNet * 12_000n) / PROBABILITY_PRECISION;

    assert.equal(postConsolationHouse, thirdHouseAfter);
    assert.equal(postConsolationReferral, thirdReferralAfter);
    assert.equal(postConsolationPending, thirdPendingAfter);
    assert.equal(postConsolationJackpot, thirdJackpotAfter - consolation12);
    assert.equal(postConsolationPlayer, thirdPlayerAfter + consolation12);

    const fourthTx = await jackpot.write.placeDirectBet([third.account.address], {
      account: secondary.account,
    });
    await waitForReceipt(fourthTx);

    const fourthHouseBefore = postConsolationHouse;
    const fourthReferralBefore = postConsolationReferral;
    const fourthJackpotBefore = postConsolationJackpot;
    const fourthPlayerBefore = postConsolationPlayer;
    const fourthPendingBefore = postConsolationPending;
    const tierIndexBefore = (await jackpot.read.getJackpotState()).nextTierIndex;
    const [, , tierPrizeBefore] = await jackpot.read.getCurrentTierInfo();

    const fourthHouseAfter = await token.read.balanceOf([house.account.address]);
    const fourthReferralAfter = await token.read.balanceOf([referral.address]);
    const fourthJackpotAfter = await jackpot.read.getJackpotBalance();
    const fourthPlayerAfter = await token.read.balanceOf([secondary.account.address]);
    const fourthPendingAfter = await referral.read.pendingRewards([third.account.address]);

    assert.equal(fourthHouseAfter - fourthHouseBefore, houseFee);
    assert.equal(fourthReferralAfter - fourthReferralBefore, referralFee);
    assert.equal(fourthJackpotAfter - fourthJackpotBefore, expectedNet);
    assert.equal(fourthPlayerBefore - fourthPlayerAfter, cost);
    assert.equal(fourthPendingAfter - fourthPendingBefore, referralFee);

    const fourthRequestId = await findRequestId(fourthTx);
    await waitForReceipt(
      await randomProvider.write.fulfill([
        fourthRequestId,
        1_000n,
      ])
    );

    const houseAfterPrize = await token.read.balanceOf([house.account.address]);
    const referralAfterPrize = await token.read.balanceOf([referral.address]);
    const jackpotAfterPrize = await jackpot.read.getJackpotBalance();
    const playerAfterPrize = await token.read.balanceOf([secondary.account.address]);
    const pendingAfterPrize = await referral.read.pendingRewards([third.account.address]);
    const tierIndexAfterPrize = (await jackpot.read.getJackpotState()).nextTierIndex;

    assert.equal(houseAfterPrize, fourthHouseAfter);
    assert.equal(referralAfterPrize, fourthReferralAfter);
    assert.equal(pendingAfterPrize, fourthPendingAfter);
    assert.equal(playerAfterPrize, fourthPlayerAfter + tierPrizeBefore);
    assert.equal(jackpotAfterPrize, fourthJackpotAfter - tierPrizeBefore);
    assert.equal(Number(tierIndexAfterPrize), Number(tierIndexBefore) + 1);

    const totalReferralExpected = referralFee * 4n;

    const referralBalanceBeforeWithdraw = await token.read.balanceOf([third.account.address]);
    await waitForReceipt(await referral.write.withdrawRewards([], { account: third.account }));
    const referralBalanceAfterWithdraw = await token.read.balanceOf([third.account.address]);
    const pendingAfterWithdraw = await referral.read.pendingRewards([third.account.address]);

    assert.equal(referralBalanceAfterWithdraw - referralBalanceBeforeWithdraw, totalReferralExpected);
    assert.equal(pendingAfterWithdraw, 0n);
  });

  it("returns default tier info when ladder empty", async () => {
    const [index0, tier0, prize0] = await jackpot.read.getCurrentTierInfo();
    assert.equal(index0, 0);
    assert.equal(prize0, 0n);
    assert.equal(tier0.useDynamicCost, true);
  });

  it("validates configuration inputs", async () => {
    await assert.rejects(
      () =>
        jackpot.write.registerGame([ZERO_ADDRESS, DEFAULT_OUTCOMES], {
          account: owner.account,
        }),
      (error: unknown) => {
        assert.match(String(error), /InvalidGame/);
        return true;
      }
    );

    await seedLadder();
    await registerDefaultGame();

    const invalidOutcomes = [
      {
        cumulativeProbability: 5_000n,
        tierAdvance: 0,
        tierResetTo: 0,
        consolationMultiplier: 0,
        awardsTier: true,
      },
      {
        cumulativeProbability: 5_000n,
        tierAdvance: 0,
        tierResetTo: 0,
        consolationMultiplier: 0,
        awardsTier: false,
      },
    ] as const;

    await assert.rejects(
      () =>
        jackpot.write.registerGame([game.address, invalidOutcomes], {
          account: owner.account,
        }),
      (error: unknown) => {
        assert.match(String(error), /InvalidProbabilityTable/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        jackpot.write.configureDirectBet([true, invalidOutcomes], {
          account: owner.account,
        }),
      (error: unknown) => {
        assert.match(String(error), /InvalidProbabilityTable/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        jackpot.write.setGameStatus([ZERO_ADDRESS, true], {
          account: owner.account,
        }),
      (error: unknown) => {
        assert.match(String(error), /InvalidGame/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        jackpot.write.setTierLadder([[]], {
          account: owner.account,
        }),
      (error: unknown) => {
        assert.match(String(error), /InvalidTierConfiguration/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        jackpot.write.addFunds([1n], {
          account: owner.account,
        }),
      (error: unknown) => {
        assert.match(String(error), /UnauthorizedCaller/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        game.write.contributeRaw([0n], {
          account: game.account,
        }),
      (error: unknown) => {
        assert.match(String(error), /Amount must be positive/);
        return true;
      }
    );


    await assert.rejects(
      () =>
        jackpot.write.fulfillRandomness([0n, 0n, [0n]], {
          account: owner.account,
        }),
      (error: unknown) => {
        assert.match(String(error), /Only provider/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        jackpot.write.handleRandomFailure([
          0n,
          "0x" + "00".repeat(32),
          "0x",
        ], {
          account: owner.account,
        }),
      (error: unknown) => {
        assert.match(String(error), /Only provider/);
        return true;
      }
    );
    await assert.rejects(
      () =>
        game.write.forwardEntry([
          secondary.account.address,
          parseEther("1"),
          PROBABILITY_PRECISION,
        ]),
      (error: unknown) => {
        assert.match(String(error), /ProbabilityOverflow/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        jackpot.write.configureDirectBet([true, []], {
          account: owner.account,
        }),
      (error: unknown) => {
        assert.match(String(error), /InvalidProbabilityTable/);
        return true;
      }
    );

    const maxEdge = await jackpot.read.MAX_DIRECT_BET_HOUSE_EDGE_BPS();
    assert.equal(Number(maxEdge), 1_000);

    await jackpot.write.setTierLadder([BEAHOLDER_LADDER], {
      account: owner.account,
    });

    await jackpot.write.registerGame([game.address, DEFAULT_OUTCOMES], {
      account: owner.account,
    });

    const tierCost = BEAHOLDER_LADDER[0].fixedBetCost;
    await assert.rejects(
      () =>
        game.write.submitEntry([
          secondary.account.address,
          tierCost,
          0n,
        ]),
      (error: unknown) => {
        assert.match(String(error), /Jackpot underfunded/);
        return true;
      }
    );
  });

  it("reverts awarding tier when next tier index exceeds ladder", async () => {
    await seedLadder();
    await registerDefaultGame();

    const testClient = await viem.getTestClient();
    const jackpotStateSlot = 4n;

    await testClient.setStorageAt({
      address: jackpot.address,
      index: padHex(toHex(jackpotStateSlot), { size: 32 }) as Hex,
      value: padHex("0x09", { size: 32 }) as Hex,
    });

    // ensure the jackpot can cover any tier prize so the revert we expect is driven by the tier index
    await token.write.transfer([jackpot.address, parseEther("20")], {
      account: owner.account,
    });

    const tierCost2 = BEAHOLDER_LADDER[0].fixedBetCost;
    await assert.rejects(
      () =>
        game.write.submitEntry([
          secondary.account.address,
          tierCost2,
          500n,
        ]),
      (error: unknown) => {
        assert.match(String(error), /InvalidTierConfiguration/);
        return true;
      }
    );
  });

  async function seedLadder() {
    await jackpot.write.setTierLadder([BEAHOLDER_LADDER], {
      account: owner.account,
    });
  }

  async function registerDefaultGame() {
    await jackpot.write.registerGame([game.address, DEFAULT_OUTCOMES], {
      account: owner.account,
    });
  }

  async function contributeFromGame(amount: bigint) {
    await token.write.approve([game.address, amount], {
      account: owner.account,
    });
    await game.write.contribute([amount], {
      account: owner.account,
    });
  }

  async function waitForReceipt(hash: Hex) {
    return publicClient.waitForTransactionReceipt({ hash });
  }

  async function findRequestId(txHash: Hex) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const logs = await publicClient.getLogs({
      address: jackpot.address,
      event: DIRECT_BET_EVENT,
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });
    assert(logs.length > 0);
    const log = logs[0];
    if (Array.isArray(log.args)) {
      return log.args[0] as bigint;
    }
    return (log.args as Record<string, unknown>).requestId as bigint;
  }
});

