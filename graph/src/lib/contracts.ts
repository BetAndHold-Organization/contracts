import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAbiItem } from "viem";

import { env } from "../config.js";

export type ContractsConfig = {
  rouletteAddress: `0x${string}`;
  jackpotAddress: `0x${string}`;
  handlerAddress: `0x${string}`;
  referralAddress: `0x${string}`;
  tokenAddress: `0x${string}`;
  randomProviderAddress: `0x${string}`;
  rouletteAbi: any[];
  jackpotAbi: any[];
  handlerAbi: any[];
  referralAbi: any[];
};

async function loadArtifact(name: string) {
  const path = join(process.cwd(), "artifacts", "contracts", `${name}.json`);
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  return parsed.abi as any[];
}

export async function loadContracts(): Promise<ContractsConfig> {
  const deploymentRaw = await readFile(env.DEPLOYMENTS_PATH, "utf8");
  const deployment = JSON.parse(deploymentRaw) as {
    roulette: `0x${string}`;
    jackpot: `0x${string}`;
    handler: `0x${string}`;
    referral: `0x${string}`;
    token: `0x${string}`;
    randomProvider: `0x${string}`;
  };

  const rouletteAbi = await loadArtifact(
    "SingleRandomRoulette.sol/SingleRandomRoulette"
  );
  const jackpotAbi = await loadArtifact(
    "ProgressiveJackpot.sol/ProgressiveJackpot"
  );
  const handlerAbi = await loadArtifact("PaymentHandler.sol/PaymentHandler");
  const referralAbi = await loadArtifact(
    "MultiLevelReferral.sol/MultiLevelReferral"
  );

  return {
    rouletteAddress: deployment.roulette,
    jackpotAddress: deployment.jackpot,
    handlerAddress: deployment.handler,
    referralAddress: deployment.referral,
    tokenAddress: deployment.token,
    randomProviderAddress: deployment.randomProvider,
    rouletteAbi,
    jackpotAbi,
    handlerAbi,
    referralAbi,
  };
}
