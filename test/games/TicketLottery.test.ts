import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";

import { ZERO_ADDRESS } from "../helpers/constants.js";
import { expectRevert } from "../helpers/utils.js";

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;
let publicClient: Awaited<ReturnType<typeof env.viem.getPublicClient>>;

let deployer: `0x${string}`;
let operator: `0x${string}`;
let other: `0x${string}`;
let p1: `0x${string}`;
let p2: `0x${string}`;
let p3: `0x${string}`;

const KEY_HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const SUB_ID = 42n;

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  publicClient = await env.viem.getPublicClient();

  deployer = walletClients[0].account.address;
  operator = walletClients[1].account.address;
  other = walletClients[2].account.address;
  p1 = walletClients[3].account.address;
  p2 = walletClients[4].account.address;
  p3 = walletClients[5].account.address;
});

async function setup(opts: { initialOperator?: `0x${string}` } = {}) {
  const coordinator = await env.viem.deployContract("MockVRFCoordinatorV2Plus");
  const lottery = await env.viem.deployContract("TicketLottery", [
    coordinator.address,
    KEY_HASH,
    SUB_ID,
    opts.initialOperator ?? ZERO_ADDRESS,
  ]);
  return { coordinator, lottery };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTRUCTOR
// ─────────────────────────────────────────────────────────────────────────────

describe("TicketLottery — constructor", () => {
  it("seeds initial operator when non-zero", async () => {
    const { lottery } = await setup({ initialOperator: operator });
    expect(await lottery.read.gameOperators([operator])).to.equal(true);
  });

  it("does not seed an operator when initialOperator = zero", async () => {
    const { lottery } = await setup();
    expect(await lottery.read.gameOperators([operator])).to.equal(false);
  });

  it("stores keyHash and subId immutables", async () => {
    const { lottery } = await setup();
    expect(await lottery.read.keyHash()).to.equal(KEY_HASH);
    expect(await lottery.read.subId()).to.equal(SUB_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requestWinners — operator-gated
// ─────────────────────────────────────────────────────────────────────────────

describe("TicketLottery — requestWinners access control", () => {
  it("rejects non-operator caller (modifier check)", async () => {
    const { lottery } = await setup(); // no operator seeded
    // Owner is not auto-operator — should revert
    await expectRevert(lottery.write.requestWinners([[p1], [1n], 1]));
  });

  it("rejects a removed operator", async () => {
    const { lottery } = await setup({ initialOperator: operator });
    await lottery.write.setGameOperator([operator, false]);
    const opLottery = await env.viem.getContractAt("TicketLottery", lottery.address, {
      client: { wallet: walletClients[1] },
    });
    await expectRevert(opLottery.write.requestWinners([[p1], [1n], 1]));
  });

  it("accepts an allowlisted operator", async () => {
    const { lottery } = await setup({ initialOperator: operator });
    const opLottery = await env.viem.getContractAt("TicketLottery", lottery.address, {
      client: { wallet: walletClients[1] },
    });
    // Should not revert
    await opLottery.write.requestWinners([[p1, p2], [10n, 5n], 1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requestWinners — input validation
// ─────────────────────────────────────────────────────────────────────────────

describe("TicketLottery — requestWinners input validation", () => {
  async function opLottery() {
    const s = await setup({ initialOperator: operator });
    return {
      ...s,
      asOperator: await env.viem.getContractAt("TicketLottery", s.lottery.address, {
        client: { wallet: walletClients[1] },
      }),
    };
  }

  it("reverts on empty player list", async () => {
    const { asOperator } = await opLottery();
    await expectRevert(asOperator.write.requestWinners([[], [], 1]));
  });

  it("reverts when player list and ticket list mismatch", async () => {
    const { asOperator } = await opLottery();
    await expectRevert(asOperator.write.requestWinners([[p1, p2], [1n], 1]));
  });

  it("reverts when numWinners = 0", async () => {
    const { asOperator } = await opLottery();
    await expectRevert(asOperator.write.requestWinners([[p1], [1n], 0]));
  });

  it("reverts when numWinners > players.length", async () => {
    const { asOperator } = await opLottery();
    await expectRevert(asOperator.write.requestWinners([[p1, p2], [1n, 1n], 3]));
  });

  it("reverts when any ticket count is zero", async () => {
    const { asOperator } = await opLottery();
    await expectRevert(asOperator.write.requestWinners([[p1, p2], [1n, 0n], 1]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requestWinners — happy path + state
// ─────────────────────────────────────────────────────────────────────────────

describe("TicketLottery — requestWinners happy path", () => {
  it("stores the lottery state, emits LotteryRequested, and reports unfulfilled", async () => {
    const { lottery, coordinator } = await setup({ initialOperator: operator });
    const opLottery = await env.viem.getContractAt("TicketLottery", lottery.address, {
      client: { wallet: walletClients[1] },
    });

    // Coordinator mock returns nextRequestId = 1 by default
    const txHash = await opLottery.write.requestWinners([[p1, p2, p3], [10n, 20n, 30n], 2]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    expect(await lottery.read.isLotteryFulfilled([1n])).to.equal(false);

    // Reading getLotteryResult while unfulfilled should revert
    await expectRevert(lottery.read.getLotteryResult([1n]));

    // Verify emitted event
    const events = await lottery.getEvents.LotteryRequested();
    const evt = events.find((e) => e.args.requestId === 1n);
    expect(evt, "LotteryRequested(1) not found").to.exist;
    expect(evt!.args.totalTickets).to.equal(60n);
    expect(evt!.args.numWinners).to.equal(2);
    expect(evt!.args.playerCount).to.equal(3n);

    // Coordinator should have observed a request from the lottery
    const coordEvents = await coordinator.getEvents.RandomnessRequested();
    expect(
      coordEvents.find((e) => e.args.requestId === 1n && e.args.sender?.toLowerCase() === lottery.address.toLowerCase()),
      "Coordinator did not see the request",
    ).to.exist;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fulfillRandomWords — selection logic
// ─────────────────────────────────────────────────────────────────────────────

describe("TicketLottery — fulfillRandomWords", () => {
  it("selects N unique winners, marks as fulfilled, emits LotteryFulfilled", async () => {
    const { lottery, coordinator } = await setup({ initialOperator: operator });
    const opLottery = await env.viem.getContractAt("TicketLottery", lottery.address, {
      client: { wallet: walletClients[1] },
    });
    await opLottery.write.requestWinners([[p1, p2, p3], [1n, 1n, 1n], 2]);

    const randomWord = 0xdeadbeefn;
    const txHash = await coordinator.write.fulfill([lottery.address, 1n, [randomWord]]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    expect(await lottery.read.isLotteryFulfilled([1n])).to.equal(true);

    const [winners, savedRandom, players, tickets, total] = await lottery.read.getLotteryResult([1n]);
    expect(winners.length).to.equal(2);
    expect(savedRandom).to.equal(randomWord);
    expect(players.length).to.equal(3);
    expect(tickets.length).to.equal(3);
    expect(total).to.equal(3n);

    // Winners must be unique and from the original player list
    const playerSet = new Set(players.map((p) => p.toLowerCase()));
    const winnerSet = new Set(winners.map((w) => w.toLowerCase()));
    expect(winnerSet.size).to.equal(winners.length);
    for (const w of winners) {
      expect(playerSet.has(w.toLowerCase()), `winner ${w} not in player list`).to.equal(true);
    }

    const events = await lottery.getEvents.LotteryFulfilled();
    expect(events.find((e) => e.args.requestId === 1n), "LotteryFulfilled(1) not emitted").to.exist;
  });

  it("respects ticket weighting: heaviest player almost always wins a single-winner draw", async () => {
    const { lottery, coordinator } = await setup({ initialOperator: operator });
    const opLottery = await env.viem.getContractAt("TicketLottery", lottery.address, {
      client: { wallet: walletClients[1] },
    });
    // p1 has 9999 tickets, p2 has 1 ticket. With 1 winner draw, p1 wins ~99.99% of the time.
    await opLottery.write.requestWinners([[p1, p2], [9999n, 1n], 1]);
    const txHash = await coordinator.write.fulfill([lottery.address, 1n, [12345n]]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    const [winners] = await lottery.read.getLotteryResult([1n]);
    expect(winners.length).to.equal(1);
    expect(winners[0].toLowerCase()).to.equal(p1.toLowerCase());
  });

  it("is deterministic: same seed + same tickets → same winners", async () => {
    const { lottery: l1, coordinator: c1 } = await setup({ initialOperator: operator });
    const { lottery: l2, coordinator: c2 } = await setup({ initialOperator: operator });
    const opL1 = await env.viem.getContractAt("TicketLottery", l1.address, {
      client: { wallet: walletClients[1] },
    });
    const opL2 = await env.viem.getContractAt("TicketLottery", l2.address, {
      client: { wallet: walletClients[1] },
    });
    await opL1.write.requestWinners([[p1, p2, p3], [5n, 3n, 2n], 2]);
    await opL2.write.requestWinners([[p1, p2, p3], [5n, 3n, 2n], 2]);
    const seed = 0x1234567890abcdefn;
    await c1.write.fulfill([l1.address, 1n, [seed]]);
    await c2.write.fulfill([l2.address, 1n, [seed]]);
    const [winners1] = await l1.read.getLotteryResult([1n]);
    const [winners2] = await l2.read.getLotteryResult([1n]);
    expect(winners1.length).to.equal(winners2.length);
    for (let i = 0; i < winners1.length; i++) {
      expect(winners1[i].toLowerCase()).to.equal(winners2[i].toLowerCase());
    }
  });

  it("reverts when fulfilling a non-existent requestId", async () => {
    const { lottery, coordinator } = await setup({ initialOperator: operator });
    // No requestWinners call first → requestId 99 has no LotteryData
    await expectRevert(coordinator.write.fulfill([lottery.address, 99n, [1n]]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// View functions
// ─────────────────────────────────────────────────────────────────────────────

describe("TicketLottery — views", () => {
  it("getLotteryResult reverts for unknown requestId", async () => {
    const { lottery } = await setup();
    await expectRevert(lottery.read.getLotteryResult([999n]));
  });

  it("isLotteryFulfilled returns false for unknown requestId", async () => {
    const { lottery } = await setup();
    expect(await lottery.read.isLotteryFulfilled([999n])).to.equal(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Operator setters (smoke; full coverage in GameLifecycleRoles tests)
// ─────────────────────────────────────────────────────────────────────────────

describe("TicketLottery — operator setters (smoke)", () => {
  it("owner can rotate operators", async () => {
    const { lottery } = await setup();
    await lottery.write.setGameOperator([operator, true]);
    expect(await lottery.read.gameOperators([operator])).to.equal(true);
    await lottery.write.setGameOperator([operator, false]);
    expect(await lottery.read.gameOperators([operator])).to.equal(false);
  });

  it("owner can batch-set operators", async () => {
    const { lottery } = await setup();
    const opB = walletClients[6].account.address;
    const opC = walletClients[7].account.address;
    await lottery.write.setGameOperators([[operator, opB, opC], true]);
    expect(await lottery.read.gameOperators([operator])).to.equal(true);
    expect(await lottery.read.gameOperators([opB])).to.equal(true);
    expect(await lottery.read.gameOperators([opC])).to.equal(true);
  });

  it("non-owner cannot rotate operators", async () => {
    const { lottery } = await setup();
    const asOther = await env.viem.getContractAt("TicketLottery", lottery.address, {
      client: { wallet: walletClients[2] },
    });
    // TicketLottery inherits Chainlink's ConfirmedOwner via VRFConsumerBaseV2Plus,
    // which uses a different revert string than OZ Ownable.
    await expectRevert(asOther.write.setGameOperator([operator, true]), "Only callable by owner");
  });
});
