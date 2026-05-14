# The Burning Games — Smart Contracts

Web3 casino-gaming platform on Arbitrum. Multiple game teams build on a shared, centrally-audited base. The contracts cover bet inflow (fees + referrals + jackpot), per-game bankroll + exposure tracking, Chainlink VRF v2.5 randomness, session-key delegated bets via an EIP-712 AuthHub, multi-level referral rewards, and a 9-tier progressive jackpot.

**Start here:**

- 📐 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — platform overview, contract layers, money flow, auth model, randomness model.
- 🛠️ [docs/GAME_AUTHOR_GUIDE.md](./docs/GAME_AUTHOR_GUIDE.md) — practical guide for writing a new game on the platform.
- 🔐 [docs/DELEGATED_AUTH.md](./docs/DELEGATED_AUTH.md) — for backend authors building the operator-relay service (session keys, EIP-712, `*For` flow).
- 📡 [docs/INDEXER_GUIDE.md](./docs/INDEXER_GUIDE.md) — for indexer authors: every event the platform emits, structured core → base → shape → game.
- 📊 [docs/probability_model.md](./docs/probability_model.md) — jackpot probability scaling math.
- 🗄️ [docs/GAME_INTEGRATION_GUIDE.v5-legacy.md](./docs/GAME_INTEGRATION_GUIDE.v5-legacy.md) — historical V5 integration guide, superseded.

**Tech stack:** Hardhat 3 + viem 2 + Solidity 0.8.20 + OpenZeppelin 4.9 + Chainlink VRF v2.5. BUSL-1.1 license.

## Prerequisites

- Node.js 18+
- npm 8+
- (Optional) Foundry CLI (`forge`) for Solidity tests and gas reporting

## Environment Setup

Copy `.env.example` to `.env` and fill in real values. The example file documents every variable, including what they're for and where to source values like the VRF coordinator address and key hash.

```bash
cp .env.example .env
# edit .env with your deployer key, RPC URL, VRF subscription ID, and a testnet mnemonic
```

The minimum required for testnet operations is `ARBITRUM_SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `VRF_COORDINATOR`, `VRF_KEY_HASH`, `VRF_SUBSCRIPTION_ID`, and `TESTNET_SEED`.

You can also keep secrets in Hardhat's keystore instead of `.env`:

```bash
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

## Deployments

Production addresses live in `scripts/mainnet/deployments/*.json`. Current V5 stack: see `arb-mainnet-v5.json` (core), `plinko-mainnet-v5.json` (Plinko), `crash-mainnet.json` (CrashGame), `lottery-mainnet.json` (TicketLottery).

## Testnet workflow (Arbitrum Sepolia)

Two entry points depending on what you're doing:

### A) New game team — deploy core only, then plug your game in

```bash
# 1. Deploy core: token, AuthHub, MLR, PaymentHandler, RandomProvider, ProgressiveJackpot.
#    Output: deployments/arbitrumSepolia-core.json
npx hardhat run scripts/testnet/deploy-core.ts --network arbitrumSepolia

# 2. Manually add the RandomProvider address as a consumer on your VRF subscription
#    at https://vrf.chain.link (one-time per subscription).

# 3. Deploy your game pointing at the core addresses from step 1, register it on
#    PaymentHandler / RandomProvider / AuthHub. The canonical pattern is documented
#    in deploy.ts (every shipped game follows the same six-step recipe) and walked
#    through in docs/GAME_AUTHOR_GUIDE.md.

# 4. Bankroll your game and start playing. See scripts/testnet/play-direct.ts for
#    the call shape (replace the per-game function with one for your game).
```

The `arbitrumSepolia-core.json` file is the contract between the platform and any game integrating against it — every consuming script (deploy, setup, play, indexer) reads it.

### B) Platform team — full deploy of every game

```bash
# 1. Deploy core + every platform game. Output: deployments/arbitrumSepolia.json
npx hardhat run scripts/testnet/deploy.ts --network arbitrumSepolia

# 2. Wire up players + approvals + session keys.
npx hardhat run scripts/testnet/setup.ts --network arbitrumSepolia

# 3. Exercise every game.
#    - Direct (player calls the game directly):
npx hardhat run scripts/testnet/play-direct.ts --network arbitrumSepolia
#    - Delegated (operator relays an EIP-712-signed action — the production flow):
npx hardhat run scripts/testnet/play-delegated.ts --network arbitrumSepolia
#    - Individual games / flows:
npx hardhat run scripts/testnet/play-jackpot.ts   --network arbitrumSepolia
npx hardhat run scripts/testnet/play-lottery.ts   --network arbitrumSepolia
npx hardhat run scripts/testnet/play-referral.ts  --network arbitrumSepolia
```

Each `play-*.ts` script is self-contained: it reads `deployments/arbitrumSepolia.json`, walks through the bet flow phase by phase, and prints the outcome. They double as worked examples for the backend team.

## License

Contracts are released under BUSL-1.1 with a configurable change date (see `LICENSE`).
