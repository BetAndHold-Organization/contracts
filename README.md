# Hardhat 3 + Viem Starter (Arbitrum Focus)

This repository is a clean Hardhat 3 project configured for TypeScript, viem-based testing, Ignition deployments, and Foundry-style Solidity tests. It targets Arbitrum One and Arbitrum Sepolia while keeping a lightweight local workflow.

## Features

- Hardhat 3 task runner with `@nomicfoundation/hardhat-toolbox-viem`
- TypeScript tests using Node's native test runner and viem assertions
- Solidity tests powered by Foundry's `forge-std`
- Ignition deployment module ready for Arbitrum networks
- BUSL-1.1 licensing to keep contracts source-available with delayed commercial use

## Prerequisites

- Node.js 18+
- npm 8+
- (Optional) Foundry CLI (`forge`) for Solidity tests and gas reporting

## Environment Setup

Create a `.env` (or use Hardhat keystore) with:

```
DEPLOYER_PRIVATE_KEY=0x...
ARBITRUM_RPC_URL=https://...
ARBITRUM_SEPOLIA_RPC_URL=https://...
ARBISCAN_API_KEY=...
ARBISCAN_SEPOLIA_API_KEY=...
```

You can also store these via Hardhat Keystore:

```
npx hardhat keystore set DEPLOYER_PRIVATE_KEY
npx hardhat keystore set ARBITRUM_RPC_URL
```

## Useful npm Scripts

- `npm run build` – compile contracts
- `npm run clean` – clean artifacts/cache
- `npm test` – run TypeScript + Solidity tests
- `npm run test:coverage` – run tests with Hardhat's built-in coverage
- `npm run test:solidity` – execute Foundry tests with gas report (requires `forge`)
- `npm run deploy:arbitrum` – deploy Ignition module to Arbitrum One
- `npm run deploy:arbitrum-sepolia` – deploy to Arbitrum Sepolia

## Networks

`hardhat.config.ts` includes:

- `hardhatArbitrum` – local simulated chain
- `arbitrum` – Arbitrum One (RPC + deployer key required)
- `arbitrumSepolia` – Arbitrum Sepolia testnet

## License

Contracts are released under BUSL-1.1 with a configurable change date (see `LICENSE`).

## Next Steps

- Replace `Counter` with your own contracts
- Adjust Ignition modules for complex deployments
- Add additional networks or build profiles as needed
