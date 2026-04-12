import type { HardhatUserConfig } from "hardhat/config";

import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import "dotenv/config";

const rpcMainnet = (process.env.MAINNET_ARBITRUM_RPC_URL ?? process.env.ARBITRUM_RPC_URL ?? "").trim();
const privMainnet = (process.env.MAINNET_DEPLOYER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY ?? "").trim();
const rpcSepolia = (process.env.ARBITRUM_SEPOLIA_RPC_URL ?? "").trim();
const privSepolia = (process.env.DEPLOYER_PRIVATE_KEY ?? privMainnet).trim();
const arbiscanKey = (process.env.MAINNET_ARBISCAN_API_KEY ?? process.env.ARBISCAN_API_KEY ?? "").trim();

if (!rpcMainnet) {
  throw new Error("Missing MAINNET_ARBITRUM_RPC_URL (or ARBITRUM_RPC_URL)");
}

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin, hardhatVerify],
  solidity: {
    profiles: {
      default: {
        version: "0.8.20",
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      production: {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 800,
          },
        },
      },
    },
  },
  networks: {
    hardhatArbitrum: {
      type: "edr-simulated",
      chainType: "generic",
    },
    arbitrum: {
      type: "http",
      chainType: "generic",
      url: rpcMainnet,
      accounts: privMainnet ? [privMainnet] : [],
    },
    arbitrumSepolia: {
      type: "http",
      chainType: "generic",
      url: rpcSepolia,
      accounts: privSepolia ? [privSepolia] : [],
    },
  },
  paths: {
    sources: "./contracts",
  },
  verify: {
    etherscan: {
      apiKey: arbiscanKey,
    },
  },
};

export default config;
