import { createPublicClient, http } from "viem";
import { hardhat } from "viem/chains";

const RPC_URL = import.meta.env.VITE_RPC_URL ?? "http://localhost:8545";

export const publicClient = createPublicClient({
  chain: hardhat,
  transport: http(RPC_URL),
});

export function getPublicClient() {
  return publicClient;
}


