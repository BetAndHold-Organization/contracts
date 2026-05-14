import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";

import { ZERO_ADDRESS } from "../../helpers/constants.js";
import { expectRevert } from "../../helpers/utils.js";

let env: Awaited<ReturnType<typeof network.connect>>;
let walletClients: Awaited<ReturnType<typeof env.viem.getWalletClients>>;
let publicClient: Awaited<ReturnType<typeof env.viem.getPublicClient>>;

let deployer: `0x${string}`;
let other: `0x${string}`;
let opA: `0x${string}`;
let opB: `0x${string}`;
let opC: `0x${string}`;

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  publicClient = await env.viem.getPublicClient();

  deployer = walletClients[0].account.address;
  other = walletClients[1].account.address;
  opA = walletClients[2].account.address;
  opB = walletClients[3].account.address;
  opC = walletClients[4].account.address;
});

async function freshHarness() {
  return env.viem.deployContract("GameLifecycleRolesHarness");
}

describe("GameLifecycleRoles — initial state", () => {
  it("has no operators after deployment", async () => {
    const h = await freshHarness();
    expect(await h.read.gameOperators([deployer])).to.equal(false);
    expect(await h.read.gameOperators([opA])).to.equal(false);
  });

  it("rejects calls to onlyGameOperator functions before any operator is added", async () => {
    const h = await freshHarness();
    await expectRevert(h.write.operatorOnly(), "NotGameOperator");
  });
});

describe("GameLifecycleRoles — setGameOperator (single)", () => {
  it("owner can add an operator", async () => {
    const h = await freshHarness();
    await h.write.setGameOperator([opA, true]);
    expect(await h.read.gameOperators([opA])).to.equal(true);
  });

  it("owner can remove an operator", async () => {
    const h = await freshHarness();
    await h.write.setGameOperator([opA, true]);
    await h.write.setGameOperator([opA, false]);
    expect(await h.read.gameOperators([opA])).to.equal(false);
  });

  it("emits GameOperatorSet when adding", async () => {
    const h = await freshHarness();
    const txHash = await h.write.setGameOperator([opA, true]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const events = await h.getEvents.GameOperatorSet();
    const found = events.find(
      (e) =>
        e.args.operator?.toLowerCase() === opA.toLowerCase() &&
        e.args.status === true,
    );
    expect(found, "GameOperatorSet(opA, true) not emitted").to.exist;
  });

  it("emits GameOperatorSet when removing", async () => {
    const h = await freshHarness();
    await h.write.setGameOperator([opA, true]);
    const txHash = await h.write.setGameOperator([opA, false]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const events = await h.getEvents.GameOperatorSet();
    const found = events.find(
      (e) =>
        e.args.operator?.toLowerCase() === opA.toLowerCase() &&
        e.args.status === false,
    );
    expect(found, "GameOperatorSet(opA, false) not emitted").to.exist;
  });

  it("reverts when setting the zero address", async () => {
    const h = await freshHarness();
    await expectRevert(h.write.setGameOperator([ZERO_ADDRESS, true]), "Invalid operator");
  });

  it("reverts when a non-owner calls setGameOperator", async () => {
    const h = await freshHarness();
    const otherClient = walletClients[1];
    await expectRevert(
      h.write.setGameOperator([opA, true], { account: otherClient.account }),
      "Ownable: caller is not the owner",
    );
  });
});

describe("GameLifecycleRoles — setGameOperators (batch)", () => {
  it("owner can add multiple operators in one call", async () => {
    const h = await freshHarness();
    await h.write.setGameOperators([[opA, opB, opC], true]);
    expect(await h.read.gameOperators([opA])).to.equal(true);
    expect(await h.read.gameOperators([opB])).to.equal(true);
    expect(await h.read.gameOperators([opC])).to.equal(true);
  });

  it("owner can remove multiple operators in one call", async () => {
    const h = await freshHarness();
    await h.write.setGameOperators([[opA, opB, opC], true]);
    await h.write.setGameOperators([[opA, opC], false]);
    expect(await h.read.gameOperators([opA])).to.equal(false);
    expect(await h.read.gameOperators([opB])).to.equal(true);
    expect(await h.read.gameOperators([opC])).to.equal(false);
  });

  it("reverts the whole batch if any address is zero", async () => {
    const h = await freshHarness();
    await expectRevert(
      h.write.setGameOperators([[opA, ZERO_ADDRESS, opB], true]),
      "Invalid operator",
    );
    // None should have been added since the tx reverted.
    expect(await h.read.gameOperators([opA])).to.equal(false);
    expect(await h.read.gameOperators([opB])).to.equal(false);
  });

  it("accepts an empty array (no-op)", async () => {
    const h = await freshHarness();
    await h.write.setGameOperators([[], true]);
    expect(await h.read.gameOperators([opA])).to.equal(false);
  });

  it("reverts when a non-owner calls setGameOperators", async () => {
    const h = await freshHarness();
    const otherClient = walletClients[1];
    await expectRevert(
      h.write.setGameOperators([[opA], true], { account: otherClient.account }),
      "Ownable: caller is not the owner",
    );
  });
});

describe("GameLifecycleRoles — onlyGameOperator modifier", () => {
  it("allows authorized operators through", async () => {
    const h = await freshHarness();
    await h.write.setGameOperator([opA, true]);
    const opAClient = walletClients.find(
      (w) => w.account.address.toLowerCase() === opA.toLowerCase(),
    )!;
    // Should not revert
    await h.write.operatorOnly({ account: opAClient.account });
  });

  it("blocks the owner if owner is not also an operator", async () => {
    const h = await freshHarness();
    // Deployer is owner but not an operator until added
    await expectRevert(h.write.operatorOnly(), "NotGameOperator");
  });

  it("blocks an address that was added then removed", async () => {
    const h = await freshHarness();
    await h.write.setGameOperator([opA, true]);
    await h.write.setGameOperator([opA, false]);
    const opAClient = walletClients.find(
      (w) => w.account.address.toLowerCase() === opA.toLowerCase(),
    )!;
    await expectRevert(
      h.write.operatorOnly({ account: opAClient.account }),
      "NotGameOperator",
    );
  });

  it("emits the inheriting contract's event when an operator calls through", async () => {
    const h = await freshHarness();
    await h.write.setGameOperator([opA, true]);
    const opAClient = walletClients.find(
      (w) => w.account.address.toLowerCase() === opA.toLowerCase(),
    )!;
    const txHash = await h.write.operatorOnly({ account: opAClient.account });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const events = await h.getEvents.Pinged();
    const found = events.find(
      (e) => e.args.caller?.toLowerCase() === opA.toLowerCase(),
    );
    expect(found, "Pinged(opA) not emitted").to.exist;
  });
});

describe("GameLifecycleRoles — independence from Ownable", () => {
  it("removing an operator does not affect ownership", async () => {
    const h = await freshHarness();
    await h.write.setGameOperator([opA, true]);
    await h.write.setGameOperator([opA, false]);
    expect((await h.read.owner()).toLowerCase()).to.equal(deployer.toLowerCase());
  });

  it("transferring ownership does not change operator allowlist", async () => {
    const h = await freshHarness();
    await h.write.setGameOperator([opA, true]);
    // Two-step ownership transfer
    await h.write.transferOwnership([other]);
    const otherClient = walletClients.find(
      (w) => w.account.address.toLowerCase() === other.toLowerCase(),
    )!;
    await h.write.acceptOwnership({ account: otherClient.account });
    expect((await h.read.owner()).toLowerCase()).to.equal(other.toLowerCase());
    // Operator allowlist preserved
    expect(await h.read.gameOperators([opA])).to.equal(true);
  });
});
