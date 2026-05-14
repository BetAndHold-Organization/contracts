/**
 * Reusable deployment helpers for tests.
 *
 * Conventions:
 *   - Each helper returns the deployed viem contract instance.
 *   - Helpers compose: deploy the dependency first, pass its address into the next.
 *   - Caller decides whether to use loadFixture or beforeEach.
 */

import type { NetworkConnection } from "hardhat/types/network";

type ViemFromConnection = Awaited<ReturnType<NetworkConnection["connect"]>>["viem"];

export async function deployToken(viem: ViemFromConnection) {
  return viem.deployContract("EverValueCoin");
}

export async function deployMultiLevelReferral(
  viem: ViemFromConnection,
  evaToken: `0x${string}`,
  defaultReceiver: `0x${string}`,
) {
  return viem.deployContract("MultiLevelReferral", [evaToken, defaultReceiver]);
}
