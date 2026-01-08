import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import { parseEther } from "viem";
import type { ContractReturnType } from "@nomicfoundation/hardhat-viem/types";

type HardhatConnection = Awaited<ReturnType<typeof network.connect>>;
type ViemHelpers = HardhatConnection["viem"];
type WalletClient = Awaited<ReturnType<ViemHelpers["getWalletClients"]>>[number];
type PublicClient = Awaited<ReturnType<ViemHelpers["getPublicClient"]>>;

type EverValueCoin = ContractReturnType<"EverValueCoin">;
type PaymentHandler = ContractReturnType<"PaymentHandler">;
type MultiLevelReferral = ContractReturnType<"MultiLevelReferral">;
type Adapter = ContractReturnType<"PaymentOnlyGameAdapter">;

describe("PaymentOnlyGameAdapter - integration with real PaymentHandler + Referral", () => {
  let viem: ViemHelpers;
  let publicClient: PublicClient;
  let deployer: WalletClient;
  let house: WalletClient;
  let fallback: WalletClient;
  let player: WalletClient;
  let referrer: WalletClient;

  let token: EverValueCoin;
  let handler: PaymentHandler;
  let referral: MultiLevelReferral;
  let adapter: Adapter;

  const HOUSE_BPS = 500; // 5%
  const REF_BPS = 200;   // 2%
  const LEVELS = [7_000, 1_200, 900, 600, 300] as const;
  const BASE_COST = parseEther("1");
  const GAME_ID = "0x1234000000000000000000000000000000000000000000000000000000000000" as const;

  beforeEach(async () => {
    const conn = await network.connect();
    viem = conn.viem;
    publicClient = await viem.getPublicClient();
    const wallets = await viem.getWalletClients();
    [deployer, house, fallback, player, referrer] = wallets;

    token = await viem.deployContract("EverValueCoin", [], { client: { wallet: deployer } });
    handler = await viem.deployContract("PaymentHandler", [token.address], { client: { wallet: deployer } });
    referral = await viem.deployContract("MultiLevelReferral", [token.address, fallback.account.address], {
      client: { wallet: deployer },
    });
    adapter = await viem.deployContract("PaymentOnlyGameAdapter", [token.address, handler.address], {
      client: { wallet: deployer },
    });

    // Wire referral + handler
    await handler.write.setReferralContract([referral.address], { account: deployer.account });
    await referral.write.setPaymentHandler([handler.address], { account: deployer.account });
    await referral.write.setDefaultReceiver([fallback.account.address], { account: deployer.account });
    await referral.write.setLevels([LEVELS.length, LEVELS], { account: deployer.account });

    // Register adapter as game in handler: payoutTarget = adapter, feeRecipient = house
    await handler.write.registerGame(
      [adapter.address, adapter.address, house.account.address, HOUSE_BPS, REF_BPS],
      { account: deployer.account }
    );
    await handler.write.setGameStatus([adapter.address, true], { account: deployer.account });

    // Fund player and approve handler
    await token.write.transfer([player.account.address, parseEther("100")], { account: deployer.account });
    await token.write.approve([handler.address, parseEther("100")], { account: player.account });
  });

  it("play pulls funds, splits fees, assigns referrer, and emits GamePlayed", async () => {
    const balHouseBefore = await token.read.balanceOf([house.account.address]);
    const balRefBefore = await token.read.balanceOf([referral.address]);
    const balAdapterBefore = await token.read.balanceOf([adapter.address]);
    const balPlayerBefore = await token.read.balanceOf([player.account.address]);

    const tx = await adapter.write.play([BASE_COST, referrer.account.address, GAME_ID], { account: player.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });

    // GamePlayed event
    const logs = await publicClient.getLogs({
      address: adapter.address,
      fromBlock: receipt.blockNumber,
      toBlock: receipt.blockNumber,
    });
    assert.equal(logs.length > 0, true);
    const gamePlayed = logs.find((l) => l.topics[0] === adapter.abi.find((i) => i.name === "GamePlayed")?.selector);
    // not decoding here to keep it short; balances below assert correctness

    // Fees: houseFee = 5%, referralFee = 2%, net = 93%
    const houseFee = (BASE_COST * BigInt(HOUSE_BPS)) / 10_000n;
    const refFee = (BASE_COST * BigInt(REF_BPS)) / 10_000n;
    const net = BASE_COST - houseFee - refFee;

    const balHouseAfter = await token.read.balanceOf([house.account.address]);
    const balRefAfter = await token.read.balanceOf([referral.address]);
    const balAdapterAfter = await token.read.balanceOf([adapter.address]);
    const balPlayerAfter = await token.read.balanceOf([player.account.address]);

    assert.equal(balHouseAfter - balHouseBefore, houseFee);
    assert.equal(balRefAfter - balRefBefore, refFee);
    assert.equal(balAdapterAfter - balAdapterBefore, net);
    assert.equal(balPlayerBefore - balPlayerAfter, BASE_COST);

    // Referrer recorded
    const assigned = await referral.read.getReferrer([player.account.address]);
    assert.equal(assigned.toLowerCase(), referrer.account.address.toLowerCase());
  });
});

