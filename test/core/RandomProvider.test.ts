import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";

import { ZERO_ADDRESS } from "../helpers/constants.js";
import { expectRevert } from "../helpers/utils.js";

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;

let deployer: `0x${string}`;
let other: `0x${string}`;

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  deployer = walletClients[0].account.address;
  other = walletClients[1].account.address;
});

/// Deploy MockVRFCoordinator + RandomProvider. Caller adds consumer + sets sub.
async function freshProvider() {
  const coordinator = await env.viem.deployContract("MockVRFCoordinatorV2Plus");
  const provider = await env.viem.deployContract("RandomProvider", [coordinator.address]);
  return { coordinator, provider };
}

/// Deploy MockVRFCoordinator + RandomProvider + MockRandomConsumer, fully wired:
///   - subId = 1
///   - consumer registered with maxRanges
async function freshWired(maxRanges: bigint = 8n) {
  const { coordinator, provider } = await freshProvider();
  const consumer = await env.viem.deployContract("MockRandomConsumer", [provider.address]);
  await provider.write.setSubscriptionId([1n]);
  await provider.write.setConsumerStatus([consumer.address, true, maxRanges]);
  return { coordinator, provider, consumer };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTRUCTOR + DEFAULTS
// ─────────────────────────────────────────────────────────────────────────────

describe("RandomProvider — constructor + defaults", () => {
  it("deploys with VRF coordinator and sane defaults", async () => {
    const { provider } = await freshProvider();
    expect(await provider.read.requestConfirmations()).to.equal(3);
    expect(await provider.read.callbackGasLimitBase()).to.equal(800000);
    expect(await provider.read.extraGasPerWord()).to.equal(5000);
    expect(await provider.read.subId()).to.equal(0n);
    expect(await provider.read.totalRequests()).to.equal(0n);
    expect(await provider.read.pendingRequestCount()).to.equal(0n);
    // Default keyHash matches the constructor literal
    const keyHash = await provider.read.keyHash();
    expect(keyHash).to.equal("0x1770bdc7eec7771f7ba4ffd640f34260d7f095b79c92d34a5b2551d6f6cfd2be");
  });

  it("constants are exposed", async () => {
    const { provider } = await freshProvider();
    expect(await provider.read.DEFAULT_MAX_RANGES()).to.equal(1n);
    expect(await provider.read.ABSOLUTE_MAX_RANGES()).to.equal(64n);
    expect(await provider.read.REQUEST_TIMEOUT()).to.equal(86400n);
    expect(await provider.read.MIN_GAS_LIMIT()).to.equal(100000n);
    expect(await provider.read.ABSOLUTE_MAX_CALLBACK_GAS()).to.equal(2_500_000n);
    expect(await provider.read.MAX_REQUEST_CONFIRMATIONS()).to.equal(200);
    expect(await provider.read.failureReasonTimeout()).to.match(/^0x[0-9a-f]{64}$/);
    expect(await provider.read.failureReasonConsumerRevert()).to.match(/^0x[0-9a-f]{64}$/);
    expect(await provider.read.failureReasonConsumerError()).to.match(/^0x[0-9a-f]{64}$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OWNER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

describe("RandomProvider — setKeyHash", () => {
  it("rejects non-owner", async () => {
    const { provider } = await freshProvider();
    const asOther = await env.viem.getContractAt("RandomProvider", provider.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.setKeyHash([("0x" + "11".repeat(32)) as `0x${string}`]));
  });

  it("rejects zero key hash", async () => {
    const { provider } = await freshProvider();
    await expectRevert(
      provider.write.setKeyHash([("0x" + "00".repeat(32)) as `0x${string}`]),
      "Invalid key hash",
    );
  });

  it("updates key hash and emits KeyHashUpdated with old + new values", async () => {
    const { provider } = await freshProvider();
    const oldHash = await provider.read.keyHash();
    const newHash = ("0x" + "ab".repeat(32)) as `0x${string}`;
    await provider.write.setKeyHash([newHash]);
    expect(await provider.read.keyHash()).to.equal(newHash);

    const events = await provider.getEvents.KeyHashUpdated();
    expect(events.length).to.equal(1);
    expect(events[0].args.oldKeyHash).to.equal(oldHash);
    expect(events[0].args.newKeyHash).to.equal(newHash);
  });
});

describe("RandomProvider — setSubscriptionId", () => {
  it("rejects non-owner", async () => {
    const { provider } = await freshProvider();
    const asOther = await env.viem.getContractAt("RandomProvider", provider.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.setSubscriptionId([1n]));
  });

  it("rejects zero subId", async () => {
    const { provider } = await freshProvider();
    await expectRevert(provider.write.setSubscriptionId([0n]), "Invalid subscription ID");
  });

  it("updates subId and emits SubscriptionIdSet", async () => {
    const { provider } = await freshProvider();
    await provider.write.setSubscriptionId([42n]);
    expect(await provider.read.subId()).to.equal(42n);

    const events = await provider.getEvents.SubscriptionIdSet();
    expect(events.length).to.equal(1);
    expect(events[0].args.subId).to.equal(42n);
  });
});

describe("RandomProvider — setConsumerStatus", () => {
  it("rejects non-owner", async () => {
    const { provider } = await freshProvider();
    const asOther = await env.viem.getContractAt("RandomProvider", provider.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.setConsumerStatus([other, true, 1n]));
  });

  it("rejects zero consumer address", async () => {
    const { provider } = await freshProvider();
    await expectRevert(
      provider.write.setConsumerStatus([ZERO_ADDRESS, true, 1n]),
      "Invalid consumer address",
    );
  });

  it("rejects maxRanges > ABSOLUTE_MAX_RANGES", async () => {
    const { provider } = await freshProvider();
    await expectRevert(
      provider.write.setConsumerStatus([other, true, 65n]),
      "Invalid max ranges",
    );
  });

  it("when maxRanges = 0, falls back to DEFAULT_MAX_RANGES (1)", async () => {
    const { provider } = await freshProvider();
    await provider.write.setConsumerStatus([other, true, 0n]);
    expect(await provider.read.allowedConsumers([other])).to.equal(true);
    expect(await provider.read.maxRangesAllowed([other])).to.equal(1n);
  });

  it("registers a consumer and emits ConsumerStatusUpdated", async () => {
    const { provider } = await freshProvider();
    await provider.write.setConsumerStatus([other, true, 8n]);
    expect(await provider.read.allowedConsumers([other])).to.equal(true);
    expect(await provider.read.maxRangesAllowed([other])).to.equal(8n);

    const events = await provider.getEvents.ConsumerStatusUpdated();
    expect(events.length).to.equal(1);
    expect(events[0].args.consumer?.toLowerCase()).to.equal(other.toLowerCase());
    expect(events[0].args.status).to.equal(true);
    expect(events[0].args.maxRanges).to.equal(8n);
  });

  it("can disable a consumer", async () => {
    const { provider } = await freshProvider();
    await provider.write.setConsumerStatus([other, true, 4n]);
    await provider.write.setConsumerStatus([other, false, 4n]);
    expect(await provider.read.allowedConsumers([other])).to.equal(false);
  });
});

describe("RandomProvider — setConfig", () => {
  it("rejects non-owner", async () => {
    const { provider } = await freshProvider();
    const asOther = await env.viem.getContractAt("RandomProvider", provider.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.setConfig([3, 200000, 5000]));
  });

  it("rejects requestConfirmations < 3", async () => {
    const { provider } = await freshProvider();
    await expectRevert(provider.write.setConfig([2, 200000, 5000]), "Invalid confirmations");
  });

  it("rejects requestConfirmations > MAX", async () => {
    const { provider } = await freshProvider();
    await expectRevert(provider.write.setConfig([201, 200000, 5000]), "Invalid confirmations");
  });

  it("rejects callbackGasLimitBase < MIN_GAS_LIMIT", async () => {
    const { provider } = await freshProvider();
    await expectRevert(provider.write.setConfig([3, 99999, 5000]), "Gas limit too low");
  });

  it("updates config and emits ConfigUpdated", async () => {
    const { provider } = await freshProvider();
    await provider.write.setConfig([5, 1_000_000, 7500]);
    expect(await provider.read.requestConfirmations()).to.equal(5);
    expect(await provider.read.callbackGasLimitBase()).to.equal(1_000_000);
    expect(await provider.read.extraGasPerWord()).to.equal(7500);

    const events = await provider.getEvents.ConfigUpdated();
    expect(events.length).to.equal(1);
    expect(events[0].args.requestConfirmations).to.equal(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

describe("RandomProvider — requestRandomNumber", () => {
  it("rejects non-allowed consumer", async () => {
    const { provider } = await freshProvider();
    await provider.write.setSubscriptionId([1n]);
    await expectRevert(provider.write.requestRandomNumber([100n]));
  });

  it("rejects when subscription is not set", async () => {
    const { provider } = await freshProvider();
    const consumer = await env.viem.deployContract("MockRandomConsumer", [provider.address]);
    await provider.write.setConsumerStatus([consumer.address, true, 1n]);
    await expectRevert(consumer.write.requestSingle([100n]));
  });

  it("rejects maxNumber = 0", async () => {
    const { provider, consumer } = await freshWired(1n);
    await expectRevert(consumer.write.requestSingle([0n]));
  });

  it("rejects maxNumber > uint128.max (bug #16)", async () => {
    const { consumer } = await freshWired(1n);
    const tooLarge = 2n ** 128n; // exactly uint128.max + 1
    await expectRevert(consumer.write.requestSingle([tooLarge]));
  });

  it("succeeds with valid input, increments counters, returns requestId", async () => {
    const { provider, consumer } = await freshWired(1n);
    await consumer.write.requestSingle([100n]);
    expect(await provider.read.totalRequests()).to.equal(1n);
    expect(await provider.read.pendingRequestCount()).to.equal(1n);
  });
});

describe("RandomProvider — requestRandomNumbers", () => {
  it("rejects empty ranges array", async () => {
    const { consumer } = await freshWired(8n);
    await expectRevert(consumer.write.requestRanges([[]]));
  });

  it("rejects ranges.length > authorized maxRanges", async () => {
    const { consumer } = await freshWired(2n);
    await expectRevert(
      consumer.write.requestRanges([[
        { min: 0n, max: 100n },
        { min: 0n, max: 100n },
        { min: 0n, max: 100n },
      ]]),
    );
  });

  it("rejects range with max <= min", async () => {
    const { consumer } = await freshWired(2n);
    await expectRevert(
      consumer.write.requestRanges([[{ min: 50n, max: 50n }]]),
    );
  });

  it("rejects total gas > ABSOLUTE_MAX_CALLBACK_GAS (bug #14 cap)", async () => {
    const { provider, consumer } = await freshWired(64n);
    // Set base near the ceiling: 2_300_000 + 64*5000 = 2_620_000 > 2_500_000
    await provider.write.setConfig([3, 2_300_000, 5000]);
    const ranges = Array.from({ length: 64 }, () => ({ min: 0n, max: 100n }));
    await expectRevert(consumer.write.requestRanges([ranges]), "Callback gas exceeds max");
  });

  it("succeeds with multiple ranges, stores RequestData", async () => {
    const { provider, consumer } = await freshWired(8n);
    await consumer.write.requestRanges([[
      { min: 0n, max: 100n },
      { min: 0n, max: 200n },
      { min: 50n, max: 75n },
    ]]);

    expect(await provider.read.pendingRequestCount()).to.equal(1n);

    const events = await provider.getEvents.RandomWordsRequested();
    expect(events.length).to.equal(1);
    expect(events[0].args.consumer?.toLowerCase()).to.equal(consumer.address.toLowerCase());
    expect(events[0].args.rangeCount).to.equal(3n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FULFILLMENT
// ─────────────────────────────────────────────────────────────────────────────

describe("RandomProvider — fulfillRandomWords", () => {
  it("rejects unknown requestId (validRequest modifier)", async () => {
    const { coordinator, provider } = await freshWired(1n);
    await expectRevert(coordinator.write.fulfill([provider.address, 999n, [42n]]));
  });

  it("rejects randomWords.length != 1", async () => {
    const { coordinator, provider, consumer } = await freshWired(1n);
    await consumer.write.requestSingle([100n]);
    const requestId = (await provider.read.totalRequests());
    await expectRevert(coordinator.write.fulfill([provider.address, requestId, [42n, 43n]]));
  });

  it("happy path: derives values, calls consumer, marks Fulfilled, decrements pending", async () => {
    const { coordinator, provider, consumer } = await freshWired(2n);
    await consumer.write.requestRanges([[
      { min: 0n, max: 100n },
      { min: 0n, max: 50n },
    ]]);
    const requestId = await provider.read.totalRequests();

    expect(await provider.read.pendingRequestCount()).to.equal(1n);
    await coordinator.write.fulfill([provider.address, requestId, [12345n]]);

    expect(await provider.read.pendingRequestCount()).to.equal(0n);
    const status = await provider.read.getRequestStatus([requestId]);
    expect(status).to.equal(2); // Fulfilled
    expect(await consumer.read.lastRequestId()).to.equal(requestId);
    expect(await consumer.read.rawWord()).to.equal(12345n);
  });

  it("times out if block.timestamp > timestamp + REQUEST_TIMEOUT, marks Failed, notifies consumer", async () => {
    const { coordinator, provider, consumer } = await freshWired(1n);
    await consumer.write.requestSingle([100n]);
    const requestId = await provider.read.totalRequests();

    // Jump past the timeout
    await env.networkHelpers.time.increase(86400 + 1);
    await coordinator.write.fulfill([provider.address, requestId, [42n]]);

    const status = await provider.read.getRequestStatus([requestId]);
    expect(status).to.equal(3); // Failed
    expect(await consumer.read.lastFailureRequestId()).to.equal(requestId);
    const timeoutTag = await provider.read.failureReasonTimeout();
    expect(await consumer.read.lastFailureReason()).to.equal(timeoutTag);
  });

  it("when consumer reverts with Error(string), marks Failed and routes to handleRandomFailure", async () => {
    const { coordinator, provider, consumer } = await freshWired(1n);
    await consumer.write.setShouldRevert([true, "boom"]);
    await consumer.write.requestSingle([100n]);
    const requestId = await provider.read.totalRequests();

    await coordinator.write.fulfill([provider.address, requestId, [12345n]]);
    const status = await provider.read.getRequestStatus([requestId]);
    expect(status).to.equal(3);
    const tag = await provider.read.failureReasonConsumerRevert();
    expect(await consumer.read.lastFailureReason()).to.equal(tag);
  });

  it("when consumer reverts low-level, marks Failed with CONSUMER_ERROR tag", async () => {
    const { coordinator, provider, consumer } = await freshWired(1n);
    await consumer.write.setLowLevelFulfillFailure([true]);
    await consumer.write.requestSingle([100n]);
    const requestId = await provider.read.totalRequests();

    await coordinator.write.fulfill([provider.address, requestId, [12345n]]);
    const status = await provider.read.getRequestStatus([requestId]);
    expect(status).to.equal(3);
    const tag = await provider.read.failureReasonConsumerError();
    expect(await consumer.read.lastFailureReason()).to.equal(tag);
  });

  it("when consumer's handleRandomFailure also reverts, emits FailureNotificationFailed event but completes cleanup", async () => {
    const { coordinator, provider, consumer } = await freshWired(1n);
    await consumer.write.setShouldRevert([true, "boom"]);
    await consumer.write.setLowLevelFailure([true]); // makes handleRandomFailure revert too
    await consumer.write.requestSingle([100n]);
    const requestId = await provider.read.totalRequests();

    await coordinator.write.fulfill([provider.address, requestId, [12345n]]);
    const status = await provider.read.getRequestStatus([requestId]);
    expect(status).to.equal(3);

    const failNotEvents = await provider.getEvents.FailureNotificationFailed();
    expect(failNotEvents.length).to.equal(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FORCE-FAIL (bug #12 recovery)
// ─────────────────────────────────────────────────────────────────────────────

describe("RandomProvider — forceFailRequest (bug #12)", () => {
  it("rejects non-owner", async () => {
    const { provider, consumer } = await freshWired(1n);
    await consumer.write.requestSingle([100n]);
    const requestId = await provider.read.totalRequests();
    const asOther = await env.viem.getContractAt("RandomProvider", provider.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(asOther.write.forceFailRequest([requestId]));
  });

  it("rejects unknown request", async () => {
    const { provider } = await freshWired(1n);
    await expectRevert(provider.write.forceFailRequest([12345n]));
  });

  it("rejects when request is not in Pending state", async () => {
    const { coordinator, provider, consumer } = await freshWired(1n);
    await consumer.write.requestSingle([100n]);
    const requestId = await provider.read.totalRequests();
    await coordinator.write.fulfill([provider.address, requestId, [42n]]); // marks Fulfilled

    await env.networkHelpers.time.increase(86400 + 1);
    await expectRevert(provider.write.forceFailRequest([requestId]));
  });

  it("rejects when timeout has not elapsed", async () => {
    const { provider, consumer } = await freshWired(1n);
    await consumer.write.requestSingle([100n]);
    const requestId = await provider.read.totalRequests();
    await expectRevert(provider.write.forceFailRequest([requestId]), "Not yet eligible");
  });

  it("succeeds after timeout: marks Failed, notifies consumer, releases pending count", async () => {
    const { provider, consumer } = await freshWired(1n);
    await consumer.write.requestSingle([100n]);
    const requestId = await provider.read.totalRequests();

    await env.networkHelpers.time.increase(86400 + 1);
    await provider.write.forceFailRequest([requestId]);

    expect(await provider.read.getRequestStatus([requestId])).to.equal(3); // Failed
    expect(await provider.read.pendingRequestCount()).to.equal(0n);
    expect(await consumer.read.lastFailureRequestId()).to.equal(requestId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VIEW FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

describe("RandomProvider — view helpers", () => {
  it("getRequestData returns full record after request + fulfill", async () => {
    const { coordinator, provider, consumer } = await freshWired(2n);
    await consumer.write.requestRanges([[
      { min: 0n, max: 100n },
      { min: 0n, max: 50n },
    ]]);
    const requestId = await provider.read.totalRequests();
    await coordinator.write.fulfill([provider.address, requestId, [777n]]);

    const data = await provider.read.getRequestData([requestId]);
    expect(data[0].toLowerCase()).to.equal(consumer.address.toLowerCase());
    expect(data[1]).to.equal(2); // Fulfilled
    expect(data[3]).to.equal(2n); // rangeCount
    expect(data[4]).to.equal(777n); // rawWord

    expect(await provider.read.getRawWord([requestId])).to.equal(777n);
    expect(await provider.read.getPendingRequestCount()).to.equal(0n);
  });

  it("rederiveValues returns derived array for fulfilled requests (bug #15: status check, not rawWord != 0)", async () => {
    const { coordinator, provider, consumer } = await freshWired(2n);
    await consumer.write.requestRanges([[
      { min: 0n, max: 100n },
      { min: 0n, max: 200n },
    ]]);
    const requestId = await provider.read.totalRequests();
    await coordinator.write.fulfill([provider.address, requestId, [555n]]);

    const values = await provider.read.rederiveValues([
      requestId,
      [
        { min: 0n, max: 100n },
        { min: 0n, max: 200n },
      ],
    ]);
    expect(values.length).to.equal(2);
    expect(values[0]).to.be.a("bigint");
    expect(values[1]).to.be.a("bigint");
  });

  it("rederiveValues rejects when status is not Fulfilled (bug #15)", async () => {
    const { provider, consumer } = await freshWired(1n);
    await consumer.write.requestSingle([100n]);
    const requestId = await provider.read.totalRequests();
    await expectRevert(
      provider.read.rederiveValues([requestId, [{ min: 0n, max: 100n }]]),
      "Request not fulfilled",
    );
  });
});
