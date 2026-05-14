import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";

import { expectRevert } from "../helpers/utils.js";

let env: Awaited<ReturnType<typeof network.connect>>;

before(async () => {
  env = await network.connect();
});

async function freshHarness() {
  return env.viem.deployContract("RandomDeriveLibHarness");
}

describe("RandomDeriveLib — deriveBounded", () => {
  it("returns empty arrays for empty input", async () => {
    const harness = await freshHarness();
    const [values, nextSeed] = await harness.read.callDerive([12345n, []]);
    expect(values.length).to.equal(0);
    expect(nextSeed).to.equal(12345n);
  });

  it("derives a single bounded value within [min, max)", async () => {
    const harness = await freshHarness();
    const [values] = await harness.read.callDerive([
      999n,
      [{ min: 10n, max: 100n }],
    ]);
    expect(values.length).to.equal(1);
    expect(values[0] >= 10n && values[0] < 100n, `value ${values[0]} not in [10, 100)`).to.equal(true);
  });

  it("derives multiple values, each within its range, with deterministic seed advance", async () => {
    const harness = await freshHarness();
    const [values, lastSeed] = await harness.read.callDerive([
      0xdeadbeefn,
      [
        { min: 0n, max: 10n },
        { min: 100n, max: 200n },
        { min: 50n, max: 75n },
      ],
    ]);
    expect(values.length).to.equal(3);
    expect(values[0] < 10n).to.equal(true);
    expect(values[1] >= 100n && values[1] < 200n).to.equal(true);
    expect(values[2] >= 50n && values[2] < 75n).to.equal(true);
    expect(lastSeed).to.not.equal(0xdeadbeefn);
  });

  it("is deterministic: same seed + same ranges → same outputs", async () => {
    const harness = await freshHarness();
    const ranges = [
      { min: 0n, max: 1000n },
      { min: 5n, max: 50n },
    ];
    const [v1] = await harness.read.callDerive([42n, ranges]);
    const [v2] = await harness.read.callDerive([42n, ranges]);
    expect(v1[0]).to.equal(v2[0]);
    expect(v1[1]).to.equal(v2[1]);
  });

  it("reverts InvalidRange when max <= min", async () => {
    const harness = await freshHarness();
    await expectRevert(
      harness.read.callDerive([
        1n,
        [{ min: 50n, max: 50n }],
      ]),
    );
    await expectRevert(
      harness.read.callDerive([
        1n,
        [{ min: 100n, max: 50n }],
      ]),
    );
  });
});

describe("RandomDeriveLib — deriveOnce", () => {
  it("derives a single value within [min, max)", async () => {
    const harness = await freshHarness();
    const [value, nextSeed] = await harness.read.callDeriveOnce([42n, 0n, 100n, 0n]);
    expect(value < 100n).to.equal(true);
    expect(nextSeed).to.not.equal(42n);
  });

  it("respects min lower bound", async () => {
    const harness = await freshHarness();
    const [value] = await harness.read.callDeriveOnce([42n, 50n, 60n, 7n]);
    expect(value >= 50n && value < 60n, `value ${value} not in [50, 60)`).to.equal(true);
  });

  it("reverts InvalidRange when max <= min", async () => {
    const harness = await freshHarness();
    await expectRevert(harness.read.callDeriveOnce([1n, 50n, 50n, 0n]));
    await expectRevert(harness.read.callDeriveOnce([1n, 100n, 50n, 0n]));
  });

  it("different index produces different next seed for the same input", async () => {
    const harness = await freshHarness();
    const [, seedA] = await harness.read.callDeriveOnce([42n, 0n, 100n, 0n]);
    const [, seedB] = await harness.read.callDeriveOnce([42n, 0n, 100n, 1n]);
    expect(seedA).to.not.equal(seedB);
  });
});

describe("RandomDeriveLib — deriveWordSequence", () => {
  it("returns empty array for count = 0", async () => {
    const harness = await freshHarness();
    const [words, lastSeed] = await harness.read.callDeriveWords([42n, 0n]);
    expect(words.length).to.equal(0);
    expect(lastSeed).to.equal(42n);
  });

  it("returns N words and a final seed", async () => {
    const harness = await freshHarness();
    const [words, lastSeed] = await harness.read.callDeriveWords([42n, 5n]);
    expect(words.length).to.equal(5);
    // Last word equals the lastSeed (matches the implementation's loop assignment)
    expect(words[4]).to.equal(lastSeed);
  });

  it("is deterministic across calls", async () => {
    const harness = await freshHarness();
    const [w1] = await harness.read.callDeriveWords([777n, 3n]);
    const [w2] = await harness.read.callDeriveWords([777n, 3n]);
    expect(w1[0]).to.equal(w2[0]);
    expect(w1[1]).to.equal(w2[1]);
    expect(w1[2]).to.equal(w2[2]);
  });

  it("each word differs from the previous (hash advances)", async () => {
    const harness = await freshHarness();
    const [words] = await harness.read.callDeriveWords([42n, 5n]);
    for (let i = 1; i < words.length; i++) {
      expect(words[i]).to.not.equal(words[i - 1]);
    }
  });
});
