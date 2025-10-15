import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";

describe("RandomDeriveLib (Hardhat viem)", async () => {
  const { viem } = await network.connect();
  const harness = await viem.deployContract(
    "contracts/mocks/RandomDeriveLibHarness.sol:RandomDeriveLibHarness"
  );

  it("derives a value within bounds for a single range", async () => {
    const seed = 12345n;
    const ranges = [{ min: 10n, max: 20n }];

    const [values, nextSeed] = await harness.read.callDerive([seed, ranges]);

    assert.equal(values.length, 1);
    assert(values[0] >= ranges[0].min && values[0] < ranges[0].max);
    assert.notEqual(nextSeed, seed);
  });

  it("chains multiple ranges deterministically", async () => {
    const seed = 0x1234n;
    const ranges = [
      { min: 0n, max: 100n },
      { min: 500n, max: 600n },
      { min: 1000n, max: 2000n },
    ];

    const [values, finalSeed] = await harness.read.callDerive([seed, ranges]);
    assert.equal(values.length, ranges.length);

    let rollingSeed = seed;
    for (let i = 0; i < ranges.length; i++) {
      const { min, max } = ranges[i];
      assert(values[i] >= min && values[i] < max);

      const [derived, nextSeed] = await harness.read.callDeriveOnce([
        rollingSeed,
        min,
        max,
        BigInt(i),
      ]);

      assert.equal(values[i], derived);
      rollingSeed = nextSeed;
    }

    assert.equal(finalSeed, rollingSeed);
  });

  it("derives raw word sequences by hashing the seed", async () => {
    const seed = 0xdeadbeefn;
    const count = 5n;

    const [words, lastSeed] = await harness.read.callDeriveWords([seed, count]);
    assert.equal(words.length, Number(count));

    let expected = seed;
    const abi = parseAbiParameters("uint256 seed,uint256 index");
    for (let i = 0n; i < count; i++) {
      expected = BigInt(keccak256(encodeAbiParameters(abi, [expected, i])));
      assert.equal(words[Number(i)], expected);
    }
    assert.equal(lastSeed, expected);
  });

  it("reverts when a range has max <= min", async () => {
    await viem.assertions.revertWithCustomError(
      harness.read.callDerive([0n, [{ min: 100n, max: 50n }]]),
      harness,
      "InvalidRange"
    );
  });

  it("deriveOnce reverts when bounds are invalid", async () => {
    await viem.assertions.revertWithCustomError(
      harness.read.callDeriveOnce([0n, 10n, 10n, 0n]),
      harness,
      "InvalidRange"
    );
  });

  it("produces different outputs for different seeds", async () => {
    const ranges = [
      { min: 0n, max: 1000n },
      { min: 1000n, max: 2000n },
    ];

    const [valuesA] = await harness.read.callDerive([1n, ranges]);
    const [valuesB] = await harness.read.callDerive([2n, ranges]);

    assert.equal(valuesA.length, valuesB.length);
    const identical = valuesA.every((value: bigint, idx: number) => value === valuesB[idx]);
    assert.equal(identical, false);
  });
});
