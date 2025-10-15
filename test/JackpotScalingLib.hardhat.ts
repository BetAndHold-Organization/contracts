import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { parseEther } from "viem";

import type { ContractReturnType } from "@nomicfoundation/hardhat-viem/types";
import type { WalletClient } from "viem";

const LINEAR = 0;
const QUADRATIC = 1;
const LOG = 2;
const EXP = 3;

type JackpotScalingHarnessContract = ContractReturnType<"JackpotScalingHarness">;

type ViemConnection = Awaited<ReturnType<typeof network.connect>>;
type Viem = ViemConnection["viem"];

type Wallet = Awaited<ReturnType<Viem["getWalletClients"]>>[number];

describe("JackpotScalingLib harness", () => {
  let viem: Viem;
  let owner: Wallet;
  let harness: JackpotScalingHarnessContract;

  const ONE = 10n ** 18n;
  const MIN_BPS = 10n;
  const MAX_BPS = 500n;
  const MIN_WAGER = parseEther("1");
  const MAX_WAGER = parseEther("100");

  beforeEach(async () => {
    ({ viem } = await network.connect());
    [owner] = await viem.getWalletClients();
    harness = await viem.deployContract("JackpotScalingHarness");
    await harness.write.setConfig([
      true,
      Number(MIN_BPS),
      Number(MAX_BPS),
      MIN_WAGER,
      MAX_WAGER,
      0,
    ], { account: owner.account });
  });

  it("returns zero below minimum", async () => {
    const result = await harness.read.computeProbability([parseEther("0.5")]);
    assert.equal(Number(result), 0);
  });

  it("returns min bps at minimum wager", async () => {
    const result = await harness.read.computeProbability([MIN_WAGER]);
    assert.equal(Number(result), Number(MIN_BPS));
  });

  it("returns max bps at or above maximum wager", async () => {
    await harness.write.setConfig([
      true,
      Number(MIN_BPS),
      Number(MAX_BPS),
      MIN_WAGER,
      MAX_WAGER,
      LINEAR,
    ], { account: owner.account });

    const atMax = await harness.read.computeProbability([MAX_WAGER]);
    const aboveMax = await harness.read.computeProbability([parseEther("150")]);
    assert.equal(Number(atMax), Number(MAX_BPS));
    assert.equal(Number(aboveMax), Number(MAX_BPS));
  });

  it("applyCurve returns ONE when normalized >= ONE", async () => {
    const result = await harness.read.callApplyCurve([LINEAR, ONE]);
    assert.equal(result, ONE);
  });

  it("applyCurve reverts on invalid function id", async () => {
    await assert.rejects(
      harness.read.callApplyCurve([99, ONE / 2n]),
      (err: any) => err.message.includes("InvalidScalingFunction")
    );
  });

  it("computes linear scaling", async () => {
    await harness.write.setConfig([
      true,
      Number(MIN_BPS),
      Number(MAX_BPS),
      MIN_WAGER,
      MAX_WAGER,
      0,
    ], { account: owner.account });

    const midWager = parseEther("50");
    const expected = linearExpected(midWager);
    const actual = await harness.read.computeProbability([midWager]);
    assert.equal(Number(actual), expected);
  });

  it("computes quadratic scaling", async () => {
    await harness.write.setConfig([
      true,
      Number(MIN_BPS),
      Number(MAX_BPS),
      MIN_WAGER,
      MAX_WAGER,
      1,
    ], { account: owner.account });

    const midWager = parseEther("50");
    const expected = quadraticExpected(midWager);
    const actual = await harness.read.computeProbability([midWager]);
    assert.equal(Number(actual), expected);
  });

  it("computes logarithmic scaling", async () => {
    await harness.write.setConfig([
      true,
      Number(MIN_BPS),
      Number(MAX_BPS),
      MIN_WAGER,
      MAX_WAGER,
      2,
    ], { account: owner.account });

    const midWager = parseEther("50");
    const expected = logExpected(midWager);
    const actual = await harness.read.computeProbability([midWager]);
    assert.equal(Number(actual), expected);
  });

  it("computes exponential scaling", async () => {
    await harness.write.setConfig([
      true,
      Number(MIN_BPS),
      Number(MAX_BPS),
      MIN_WAGER,
      MAX_WAGER,
      3,
    ], { account: owner.account });

    const midWager = parseEther("50");
    const expected = exponentialExpected(midWager);
    const actual = await harness.read.computeProbability([midWager]);
    assert.equal(Number(actual), expected);
  });

  it("reverts when scaling disabled", async () => {
    await harness.write.setConfig([
      false,
      Number(MIN_BPS),
      Number(MAX_BPS),
      MIN_WAGER,
      MAX_WAGER,
      0,
    ], { account: owner.account });

    await assert.rejects(
      harness.read.computeProbability([MIN_WAGER]),
      (err: any) => err.message.includes("ScalingDisabled")
    );
  });

  it("reverts on invalid range", async () => {
    await harness.write.setConfig([
      true,
      600,
      500,
      MIN_WAGER,
      MAX_WAGER,
      0,
    ], { account: owner.account });

    await assert.rejects(
      harness.read.computeProbability([parseEther("10")]),
      (err: any) => err.message.includes("InvalidScalingRange")
    );
  });

  it("reverts on invalid bounds", async () => {
    await harness.write.setConfig([
      true,
      Number(MIN_BPS),
      Number(MAX_BPS),
      MIN_WAGER,
      MIN_WAGER,
      0,
    ], { account: owner.account });

    await assert.rejects(
      harness.read.computeProbability([parseEther("10")]),
      (err: any) => err.message.includes("InvalidScalingBounds")
    );
  });

  it("reverts on invalid scaling function id", async () => {
    await assert.rejects(
      harness.write.setConfig([
        true,
        Number(MIN_BPS),
        Number(MAX_BPS),
        MIN_WAGER,
        MAX_WAGER,
        99,
      ], { account: owner.account })
    );
  });

  it("reverts when max jackpot bps is below min", async () => {
    await harness.write.setConfig([
      true,
      500,
      10,
      MIN_WAGER,
      MAX_WAGER,
      LINEAR,
    ], { account: owner.account });

    await assert.rejects(
      harness.read.computeProbability([parseEther("10")]),
      (err: any) => err.message.includes("InvalidScalingRange")
    );
  });

  it("returns zero when max jackpot percentage is zero", async () => {
    await harness.write.setConfig([
      true,
      0,
      0,
      MIN_WAGER,
      MAX_WAGER,
      LINEAR,
    ], { account: owner.account });

    const result = await harness.read.computeProbability([parseEther("10")]);
    assert.equal(Number(result), 0);
  });

  function normalized(wager: bigint): bigint {
    const span = MAX_WAGER - MIN_WAGER;
    return ((wager - MIN_WAGER) * ONE) / span;
  }

  function translate(normalizedValue: bigint): number {
    const delta = MAX_BPS - MIN_BPS;
    return Number(MIN_BPS + (delta * normalizedValue) / ONE);
  }

  function linearExpected(wager: bigint): number {
    return translate(normalized(wager));
  }

  function quadraticExpected(wager: bigint): number {
    const norm = normalized(wager);
    const scaled = (norm * norm) / ONE;
    return translate(scaled);
  }

  function logExpected(wager: bigint): number {
    const norm = normalized(wager);
    const scaled = sqrt(norm * ONE);
    return translate(scaled);
  }

  function exponentialExpected(wager: bigint): number {
    const norm = normalized(wager);
    const squared = (norm * norm) / ONE;
    const cubed = (squared * norm) / ONE;
    return translate(cubed);
  }

  function sqrt(x: bigint): bigint {
    if (x === 0n) return 0n;
    let z = (x + 1n) / 2n;
    let y = x;
    while (z < y) {
      y = z;
      z = (x / z + z) / 2n;
    }
    return y;
  }
});
