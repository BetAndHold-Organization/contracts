import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { parseEventLogs, parseEther } from "viem";
import type { Hex } from "viem";
import type { ContractReturnType } from "@nomicfoundation/hardhat-viem/types";

type HardhatConnection = Awaited<ReturnType<typeof network.connect>>;
type ViemHelpers = HardhatConnection["viem"];
type WalletClient = Awaited<ReturnType<ViemHelpers["getWalletClients"]>>[number];
type PublicClient = Awaited<ReturnType<ViemHelpers["getPublicClient"]>>;

type EverValueCoin = ContractReturnType<"EverValueCoin">;
type Adapter = ContractReturnType<"PaymentOnlyGameAdapter">;
type MockHandler = ContractReturnType<"MockPaymentHandlerForAdapter">;

describe("PaymentOnlyGameAdapter", () => {
  let viem: ViemHelpers;
  let publicClient: PublicClient;
  let owner: WalletClient;
  let other: WalletClient;

  let token: EverValueCoin;
  let handler: MockHandler;
  let adapter: Adapter;

  const ONE = parseEther("1");
  const NET = parseEther("0.7");
  const GAME_ID = "0x1234000000000000000000000000000000000000000000000000000000000000" as const;

  beforeEach(async () => {
    const conn = await network.connect();
    viem = conn.viem;
    publicClient = await viem.getPublicClient();
    const wallets = await viem.getWalletClients();
    [owner, other] = wallets;

    token = await viem.deployContract("EverValueCoin", [], { client: { wallet: owner } });
    handler = await viem.deployContract("MockPaymentHandlerForAdapter", [], { client: { wallet: owner } });
    adapter = await viem.deployContract("PaymentOnlyGameAdapter", [token.address, handler.address], {
      client: { wallet: owner },
    });
  });

  it("play charges via handler and emits GamePlayed with gameId", async () => {
    // mock handler will return NET
    await handler.write.setNetAmount([NET], { account: owner.account });

    const txHash = await adapter.write.play([ONE, other.account.address, GAME_ID], { account: owner.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    const logs = parseEventLogs({
      abi: adapter.abi,
      logs: receipt.logs,
      eventName: "GamePlayed",
    });
    assert.equal(logs.length, 1);
    const ev = logs[0];
    assert.equal(ev.args.player, owner.account.address);
    assert.equal(ev.args.amountPaid, ONE);
    assert.equal(ev.args.netAmount, NET);
    assert.equal(ev.args.potentialReferrer, other.account.address);
    assert.equal(ev.args.gameId, GAME_ID);

    // verify handler saw the call
    const lastBettor = await handler.read.lastBettor();
    const lastReferrer = await handler.read.lastReferrer();
    const lastBaseCost = await handler.read.lastBaseCost();
    assert.equal(lastBettor, owner.account.address);
    assert.equal(lastReferrer, other.account.address);
    assert.equal(lastBaseCost, ONE);
  });

  it("play reverts on zero amount", async () => {
    await assert.rejects(
      adapter.write.play([0n, other.account.address, GAME_ID], { account: owner.account }),
      /amount=0/
    );
  });

  it("only owner can payWinner and withdraw", async () => {
    // fund adapter
    await token.write.transfer([adapter.address, ONE], { account: owner.account });

    // payWinner as owner
    const payTx = await adapter.write.payWinner([other.account.address, ONE], { account: owner.account });
    await publicClient.waitForTransactionReceipt({ hash: payTx });
    const bal = await token.read.balanceOf([other.account.address]);
    assert.equal(bal, ONE);

    // withdraw revert when non-owner
    await assert.rejects(
      adapter.write.withdraw([owner.account.address, 1n], { account: other.account }),
      /not owner/
    );
  });

  it("setOwner updates owner", async () => {
    const tx = await adapter.write.setOwner([other.account.address], { account: owner.account });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    const tx2 = await adapter.write.setOwner([owner.account.address], { account: other.account });
    await publicClient.waitForTransactionReceipt({ hash: tx2 });
  });
});






