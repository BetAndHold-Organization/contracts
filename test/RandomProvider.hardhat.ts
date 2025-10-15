import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import {
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  parseAbiItem,
  parseAbiParameters,
} from "viem";

const HASH_ABI = parseAbiParameters("uint256,uint256");
const FAILURE_EVENT = parseAbiItem(
  "event FailureNotificationFailed(uint256 indexed requestId, address indexed consumer, bytes32 failureTag, bytes reason)"
);
const REQUEST_EVENT = parseAbiItem(
  "event RandomWordsRequested(uint256 indexed requestId, address indexed consumer, uint256 rangeCount, uint256 gasLimit)"
);

function range(min: bigint, max: bigint) {
  return { min, max };
}

function deriveValues(
  seed: bigint,
  ranges: Array<{ min: bigint; max: bigint }>
) {
  let current = seed;
  const derived: bigint[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const { min, max } = ranges[i];
    const span = max - min;
    const value = (current % span) + min;
    derived.push(value);
    const encoded = encodeAbiParameters(HASH_ABI, [current, BigInt(i)]);
    current = BigInt(keccak256(encoded));
  }
  return derived;
}

describe("RandomProvider (Hardhat viem)", async () => {
  const { viem } = await network.connect();

  let coordinator: any;
  let provider: any;
  let consumerA: any;
  let consumerB: any;
  let owner: any;
  let testClient: any;
  let publicClient: any;

  async function latestRequestId(provider: any) {
    const all = await provider.read.getAllRequestIds();
    assert(all.length > 0);
    return all[all.length - 1];
  }

  async function fulfill(
    coordinator: any,
    provider: any,
    owner: any,
    requestId: bigint,
    word: bigint
  ) {
    return coordinator.write.fulfill([provider.address, requestId, [word]], {
      account: owner.account,
    });
  }

  async function assertRequestTracking(
    provider: any,
    requestId: bigint,
    consumer: string,
    rangeCount: number,
    isPending: boolean
  ) {
    const requestData = await provider.read.getRequestData([requestId]);
    assert.strictEqual(
      requestData.consumer.toLowerCase(),
      consumer.toLowerCase()
    );
    assert.equal(Number(requestData.rangeCount), rangeCount);

    const derived = await provider.read.getDerivedValues([requestId]);
    if (isPending) {
      assert.equal(derived.length, 0);
    }

    const allIds = await provider.read.getAllRequestIds();
    assert(allIds.includes(requestId));

    const totalRequests = await provider.read.totalRequests();
    assert.equal(totalRequests, BigInt(allIds.length));

    const consumerIds = await provider.read.getConsumerRequests([consumer]);
    assert(consumerIds.includes(requestId));

    const consumerCount = await provider.read.getConsumerRequestCount([
      consumer,
    ]);
    assert.equal(consumerCount, BigInt(consumerIds.length));

    const pendingIds = await provider.read.getPendingRequestIds();
    const includes = pendingIds.includes(requestId);
    assert.equal(includes, isPending);

    const pendingCount = await provider.read.getPendingRequestCount();
    assert.equal(pendingCount, BigInt(pendingIds.length));
  }

  beforeEach(async () => {
    [owner] = await viem.getWalletClients();
    testClient = await viem.getTestClient();
    publicClient = await viem.getPublicClient();

    coordinator = await viem.deployContract("MockVRFCoordinatorV2Plus");
    provider = await viem.deployContract("RandomProvider", [
      coordinator.address,
    ]);
    consumerA = await viem.deployContract("MockRandomConsumer", [
      provider.address,
    ]);
    consumerB = await viem.deployContract("MockRandomConsumer", [
      provider.address,
    ]);

    await provider.write.setKeyHash([keccak256("0x01")], {
      account: owner.account,
    });
    await provider.write.setSubscriptionId([1n], { account: owner.account });
    await provider.write.setConsumerStatus([consumerA.address, true, 8n], {
      account: owner.account,
    });
    await provider.write.setConsumerStatus([consumerB.address, true, 5n], {
      account: owner.account,
    });
  });

  it("allows whitelisted consumer to request and fulfill single range", async () => {
    await consumerA.write.requestSingle([100n], { account: owner.account });
    const requestId = await latestRequestId(provider);

    await viem.assertions.revertWithCustomError(
      provider.read.requestRandomNumber([100n]),
      provider,
      "UnauthorizedCaller"
    );

    const randomWord = 123456789n;
    await publicClient.waitForTransactionReceipt({
      hash: await fulfill(coordinator, provider, owner, requestId, randomWord),
    });

    const status = await provider.read.getRequestStatus([requestId]);
    assert.equal(BigInt(status), 2n);
    const storedWord = await provider.read.getRawWord([requestId]);
    assert.equal(storedWord, randomWord);

    const derived = await provider.read.getDerivedValues([requestId]);
    assert.equal(derived.length, 1);
    assert(derived[0] < 100n);

    await assertRequestTracking(
      provider,
      requestId,
      consumerA.address,
      1,
      false
    );
  });

  it("handles multiple ranges and stores derived values", async () => {
    const ranges = [range(0n, 100n), range(200n, 250n), range(5n, 10n)];
    await consumerA.write.requestRanges([ranges], { account: owner.account });
    const requestId = await latestRequestId(provider);

    await assertRequestTracking(
      provider,
      requestId,
      consumerA.address,
      ranges.length,
      true
    );

    const word = 987654321n;
    await publicClient.waitForTransactionReceipt({
      hash: await fulfill(coordinator, provider, owner, requestId, word),
    });

    const derived = await provider.read.getDerivedValues([requestId]);
    assert.equal(derived.length, ranges.length);

    const expected = deriveValues(
      word,
      ranges.map((r) => ({ min: r.min, max: r.max }))
    );
    assert.deepEqual(
      derived,
      expected,
      "derived values should match deterministic expansion"
    );

    await assertRequestTracking(
      provider,
      requestId,
      consumerA.address,
      ranges.length,
      false
    );

    const pendingIds = await provider.read.getPendingRequestIds();
    assert(!pendingIds.includes(requestId));
  });

  it("marks request failed on timeout", async () => {
    const ranges = [range(0n, 10n)];
    await consumerA.write.requestRanges([ranges], { account: owner.account });
    const requestId = await latestRequestId(provider);

    const timeout = await provider.read.REQUEST_TIMEOUT();
    await testClient.increaseTime({ seconds: timeout + 1n });
    await testClient.mine({ blocks: 1n });

    const word = 55n;
    await publicClient.waitForTransactionReceipt({
      hash: await fulfill(coordinator, provider, owner, requestId, word),
    });

    const status = await provider.read.getRequestStatus([requestId]);
    assert.equal(BigInt(status), 3n);

    const lastFailureId = await consumerA.read.lastFailureRequestId();
    assert.equal(lastFailureId, requestId);

    const pendingIds = await provider.read.getPendingRequestIds();
    assert(!pendingIds.includes(requestId));
  });

  it("records consumer revert failures", async () => {
    const ranges = [range(0n, 10n)];
    await consumerA.write.requestRanges([ranges], { account: owner.account });
    const requestId = await latestRequestId(provider);

    await consumerA.write.setShouldRevert([true, "nope"], {
      account: owner.account,
    });
    const word = 42n;

    await publicClient.waitForTransactionReceipt({
      hash: await fulfill(coordinator, provider, owner, requestId, word),
    });

    const status = await provider.read.getRequestStatus([requestId]);
    assert.equal(BigInt(status), 3n);
    const lastFailureReason = await consumerA.read.lastFailureReason();
    assert.equal(
      lastFailureReason,
      await provider.read.failureReasonConsumerRevert()
    );

    await consumerA.write.reset({ account: owner.account });
  });

  it("enforces consumer range limits", async () => {
    const ranges = [
      range(0n, 10n),
      range(0n, 10n),
      range(0n, 10n),
      range(0n, 10n),
      range(0n, 10n),
      range(0n, 10n),
    ];

    await viem.assertions.revertWithCustomError(
      consumerB.write.requestRanges([ranges], { account: owner.account }),
      provider,
      "ExceedsMaxRanges"
    );
  });

  it("requires subscription id before requests", async () => {
    const { viem: viem2 } = await network.connect();
    const coordinator2 = await viem2.deployContract("MockVRFCoordinatorV2Plus");
    const provider2 = await viem2.deployContract("RandomProvider", [
      coordinator2.address,
    ]);
    const consumer = await viem2.deployContract("MockRandomConsumer", [
      provider2.address,
    ]);
    const owner = (await viem2.getWalletClients())[0];
    await provider2.write.setKeyHash([keccak256("0x02")], {
      account: owner.account,
    });
    await provider2.write.setConsumerStatus([consumer.address, true, 2n], {
      account: owner.account,
    });

    await viem2.assertions.revertWithCustomError(
      consumer.write.requestSingle([5n], { account: owner.account }),
      provider2,
      "SubscriptionNotSet"
    );
  });

  it("tracks request metadata across getters", async () => {
    const ranges = [range(0n, 50n), range(100n, 150n)];
    await consumerA.write.requestRanges([ranges], { account: owner.account });
    const requestId = await latestRequestId(provider);

    await assertRequestTracking(
      provider,
      requestId,
      consumerA.address,
      ranges.length,
      true
    );

    const word = 123123123n;
    await publicClient.waitForTransactionReceipt({
      hash: await fulfill(coordinator, provider, owner, requestId, word),
    });

    await assertRequestTracking(
      provider,
      requestId,
      consumerA.address,
      ranges.length,
      false
    );

    const data = await provider.read.getRequestData([requestId]);
    const rawWord = await provider.read.getRawWord([requestId]);
    assert.equal(rawWord, word);
    const derived = await provider.read.getDerivedValues([requestId]);
    assert.equal(derived.length, ranges.length);
    assert.equal(BigInt(data.status), 2n);
  });

  it("handles low-level consumer failures", async () => {
    const ranges = [range(0n, 10n)];
    await consumerA.write.requestRanges([ranges], { account: owner.account });
    const requestId = await latestRequestId(provider);

    await consumerA.write.setLowLevelFailure([true], {
      account: owner.account,
    });
    await consumerA.write.setLowLevelFulfillFailure([true], {
      account: owner.account,
    });
    const word = 99n;
    const txHash = await fulfill(coordinator, provider, owner, requestId, word);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    const status = await provider.read.getRequestStatus([requestId]);
    assert.equal(BigInt(status), 3n);
    const reasonStored = await consumerA.read.lastFailureReason();
    assert.equal(
      reasonStored,
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    );

    const events = await publicClient.getLogs({
      address: provider.address,
      event: FAILURE_EVENT,
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });
    const failureLog = events.find(
      (log: any) => log.args.requestId === requestId
    );
    assert(failureLog, "FailureNotificationFailed event not emitted");
    assert.equal(
      failureLog.args.failureTag,
      await provider.read.failureReasonConsumerError()
    );
    assert.equal(failureLog.args.reason, "0x");

    await consumerA.write.reset({ account: owner.account });
  });

  it("allows owner to update config and consumer status", async () => {
    const [, secondary] = await viem.getWalletClients();

    await consumerB.write.requestRanges([[range(0n, 5n)]], {
      account: owner.account,
    });
    const requestId = await latestRequestId(provider);
    await publicClient.waitForTransactionReceipt({
      hash: await fulfill(coordinator, provider, owner, requestId, 1n),
    });

    await viem.assertions.revertWith(
      provider.write.setConfig([2, 100000n, 1000n], {
        account: secondary.account,
      }),
      "Only callable by owner"
    );

    await provider.write.setConfig([5, 500000n, 7000n], {
      account: owner.account,
    });
    const confirmations = await provider.read.requestConfirmations();
    assert.equal(BigInt(confirmations), 5n);

    await provider.write.setConsumerStatus([consumerB.address, false, 1n], {
      account: owner.account,
    });

    await viem.assertions.revertWithCustomError(
      consumerB.write.requestRanges([[range(0n, 5n)]], {
        account: owner.account,
      }),
      provider,
      "UnauthorizedCaller"
    );

    await provider.write.setConsumerStatus([consumerB.address, true, 1n], {
      account: owner.account,
    });
  });

  it("exposes failure reason helpers", async () => {
    const timeout = await provider.read.failureReasonTimeout();
    assert.equal(timeout, await provider.read.FAILURE_TIMEOUT());
    const consumerRevert = await provider.read.failureReasonConsumerRevert();
    assert.equal(consumerRevert, await provider.read.FAILURE_CONSUMER_REVERT());
    const consumerError = await provider.read.failureReasonConsumerError();
    assert.equal(consumerError, await provider.read.FAILURE_CONSUMER_ERROR());
  });

  it("reverts when requesting zero ranges", async () => {
    await viem.assertions.revertWithCustomError(
      consumerA.write.requestRanges([[]], { account: owner.account }),
      provider,
      "InvalidMaxNumber"
    );
  });

  it("reverts when fulfilling unknown request id", async () => {
    await viem.assertions.revertWithCustomError(
      coordinator.write.fulfill([provider.address, 999999999n, [1n]]),
      provider,
      "InvalidRequestId"
    );
  });

  it("reverts when fulfill receives wrong random word count", async () => {
    await consumerA.write.requestSingle([100n], { account: owner.account });
    const requestId = await latestRequestId(provider);

    await viem.assertions.revertWithCustomError(
      coordinator.write.fulfill([provider.address, requestId, [11n, 22n]]),
      provider,
      "InvalidRandomWords"
    );
  });

  it(
    "saturates multiple games with heavy range requests",
    { timeout: 120_000 },
    async () => {
      const gameCount = 10;
      const betsPerGame = 10;
      const totalBets = gameCount * betsPerGame;

      const games: any[] = [];
      const rangeLookup = new Map<
        string,
        Array<{ min: bigint; max: bigint }>
      >();

      for (let i = 0; i < gameCount; i++) {
        const consumer = await viem.deployContract("MockRandomConsumer", [
          provider.address,
        ]);
        games.push(consumer);

        const rangeCount = (i % 6) + 1;
        const ranges = Array.from({ length: rangeCount }, (_, j) => {
          const min = BigInt((i + 1) * 17 + j * 3);
          const max = min + BigInt(11 + j * 2);
          return range(min, max);
        });
        rangeLookup.set(consumer.address.toLowerCase(), ranges);

        await provider.write.setConsumerStatus(
          [consumer.address, true, BigInt(rangeCount)],
          {
            account: owner.account,
          }
        );
      }

      const requestIds: bigint[] = [];

      for (const game of games) {
        const ranges = rangeLookup.get(game.address.toLowerCase());
        assert(ranges);

        for (let bet = 0; bet < betsPerGame; bet++) {
          const txHash = await game.write.requestRanges([ranges], {
            account: owner.account,
          });
          await publicClient.waitForTransactionReceipt({
            hash: txHash,
          });
          const requestId = await latestRequestId(provider);
          requestIds.push(requestId);
        }
      }

      assert.equal(requestIds.length, totalBets);
      assert.equal(
        await provider.read.getPendingRequestCount(),
        BigInt(totalBets)
      );

      for (let i = requestIds.length - 1; i > 0; i--) {
        const seed = BigInt(
          keccak256(
            encodeAbiParameters(HASH_ABI, [requestIds[i], BigInt(i)])
          )
        );
        const j = Number(seed % BigInt(i + 1));
        [requestIds[i], requestIds[j]] = [requestIds[j], requestIds[i]];
      }

      for (let i = 0; i < requestIds.length; i++) {
        const requestId = requestIds[i];
        const word = BigInt(
          keccak256(encodeAbiParameters(HASH_ABI, [requestId, BigInt(i)]))
        );
        const txHash = await fulfill(
          coordinator,
          provider,
          owner,
          requestId,
          word
        );
        await publicClient.waitForTransactionReceipt({ hash: txHash });

        const data = await provider.read.getRequestData([requestId]);
        assert.equal(BigInt(data.status), 2n);
        assert.equal(data.rawWord, word);

        const expectedRanges = rangeLookup.get(data.consumer.toLowerCase());
        assert(expectedRanges, "consumer ranges missing");
        assert.equal(Number(data.rangeCount), expectedRanges.length);

        const expectedValues = deriveValues(word, expectedRanges);
        const actualValues = await provider.read.getDerivedValues([requestId]);
        assert.equal(actualValues.length, expectedValues.length);

        for (let j = 0; j < expectedRanges.length; j++) {
          assert.equal(actualValues[j], expectedValues[j]);
        }
      }

      assert.equal(await provider.read.getPendingRequestCount(), 0n);
      assert.equal(
        await provider.read.totalRequests(),
        BigInt(requestIds.length)
      );

      for (const game of games) {
        const count = await provider.read.getConsumerRequestCount([
          game.address,
        ]);
        assert.equal(count, BigInt(betsPerGame));
      }

      const allIds = await provider.read.getAllRequestIds();
      assert.equal(allIds.length, requestIds.length);
    }
  );
});
