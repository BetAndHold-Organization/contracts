import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";

import { ONE_EVA, ONE_THOUSAND_EVA } from "../helpers/constants.js";
import { expectRevert } from "../helpers/utils.js";

type Env = Awaited<ReturnType<typeof network.connect>>;

const MAX_SUPPLY = 21_000_000n * ONE_EVA;

let env: Env;
let walletClients: Awaited<ReturnType<Env["viem"]["getWalletClients"]>>;
let deployer: `0x${string}`;
let alice: `0x${string}`;

before(async () => {
  env = await network.connect();
  walletClients = await env.viem.getWalletClients();
  deployer = walletClients[0].account.address;
  alice = walletClients[1].account.address;
});

async function freshToken() {
  return env.viem.deployContract("EverValueCoin");
}

describe("EverValueCoin — deployment", () => {
  it("mints MAX_SUPPLY to the deployer", async () => {
    const token = await freshToken();
    expect(await token.read.totalSupply()).to.equal(MAX_SUPPLY);
    expect(await token.read.balanceOf([deployer])).to.equal(MAX_SUPPLY);
    expect(await token.read.MAX_SUPPLY()).to.equal(MAX_SUPPLY);
  });

  it("uses the configured name and symbol", async () => {
    const token = await freshToken();
    expect(await token.read.name()).to.equal("TestRouletteToken");
    expect(await token.read.symbol()).to.equal("TRT");
    expect(await token.read.decimals()).to.equal(18);
  });
});

describe("EverValueCoin — burn (caller burns own balance)", () => {
  it("reduces caller balance and totalSupply", async () => {
    const token = await freshToken();
    await token.write.burn([ONE_THOUSAND_EVA]);
    expect(await token.read.balanceOf([deployer])).to.equal(MAX_SUPPLY - ONE_THOUSAND_EVA);
    expect(await token.read.totalSupply()).to.equal(MAX_SUPPLY - ONE_THOUSAND_EVA);
  });

  it("reverts when burning more than balance", async () => {
    const token = await freshToken();
    const tokenAsAlice = await env.viem.getContractAt(
      "EverValueCoin",
      token.address,
      { client: { wallet: walletClients[1] } },
    );
    // Alice has zero balance; any burn should revert
    await expectRevert(tokenAsAlice.write.burn([1n]));
  });
});

describe("EverValueCoin — burnFrom (spender burns from approved account)", () => {
  it("burns approved amount and decrements allowance", async () => {
    const token = await freshToken();

    // Deployer approves alice to spend 5,000 EVA
    const approveAmount = 5_000n * ONE_EVA;
    await token.write.approve([alice, approveAmount]);

    expect(await token.read.allowance([deployer, alice])).to.equal(approveAmount);

    // Alice burns 1,000 EVA from deployer's balance
    const tokenAsAlice = await env.viem.getContractAt(
      "EverValueCoin",
      token.address,
      { client: { wallet: walletClients[1] } },
    );
    await tokenAsAlice.write.burnFrom([deployer, ONE_THOUSAND_EVA]);

    expect(await token.read.balanceOf([deployer])).to.equal(MAX_SUPPLY - ONE_THOUSAND_EVA);
    expect(await token.read.totalSupply()).to.equal(MAX_SUPPLY - ONE_THOUSAND_EVA);
    expect(await token.read.allowance([deployer, alice])).to.equal(approveAmount - ONE_THOUSAND_EVA);
  });

  it("reverts when allowance is insufficient", async () => {
    const token = await freshToken();
    await token.write.approve([alice, ONE_EVA]);

    const tokenAsAlice = await env.viem.getContractAt(
      "EverValueCoin",
      token.address,
      { client: { wallet: walletClients[1] } },
    );
    await expectRevert(tokenAsAlice.write.burnFrom([deployer, ONE_THOUSAND_EVA]));
  });
});
