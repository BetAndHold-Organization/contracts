import type { HardhatUserConfig } from "hardhat/config";

import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable } from "hardhat/config";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import "dotenv/config";
const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin, hardhatVerify],
  solidity: {
    profiles: {
      default: {
        version: "0.8.20",
        settings: {
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
      url: configVariable("ARBITRUM_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
    arbitrumSepolia: {
      type: "http",
      chainType: "generic",
      url: configVariable("ARBITRUM_SEPOLIA_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
  paths: {
    sources: "./contracts",
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ARBISCAN_API_KEY"),
    },
  },
};

export default config;
