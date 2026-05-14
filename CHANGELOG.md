# Changelog

Notable changes to the platform contracts. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) loosely: each entry groups changes by category, breaking changes are called out explicitly.

Entries are roughly chronological; older platform history (V1–V5 mainnet deploys) lives in `scripts/mainnet/deployments/*.json` deployment notes and is not retroactively reconstructed here.

This file primarily exists so downstream consumers (the indexer team, backend team, external game teams) can spot breaking schema / interface / address changes between snapshots of this repo.

---

## Unreleased — `upgrades` branch (in progress)

This branch is the platform-standardization pass before opening the repo to external game teams. All changes pre-mainnet; safe to break event schemas and rename storage.

### Standardization

- **Multicallable mixin** — every game-shape and `ProgressiveJackpot` now inherit `Multicallable`, exposing `multicallTry(bytes[])` for operator-relayed batch execution with per-sub-call revert isolation. Gated by an abstract `_multicallAuthorized(address)` hook, implemented by every shape base / PJ as `authHub.isOperator(caller)`. See `docs/ARCHITECTURE.md §3` and `docs/DELEGATED_AUTH.md §7`.
- **Unified `gameOperators` allowlist** — Mines's bespoke `oracleSigner` was removed and folded into the shared `GameLifecycleRoles.gameOperators` allowlist. A new `_verifyOperatorAttestation` helper on `GameLifecycleRoles` does the ECDSA recovery + allowlist check; Mines's `claim` path uses it for click-outcome signatures. Backend rotation: one allowlist now covers both lifecycle ops AND attestation signing.
- **Canonical platform interfaces** — every game now consumes platform contracts through interfaces in `contracts/interfaces/core/` and `contracts/interfaces/auth/`. Redeclarations forbidden. See `CONTRIBUTING.md` and `docs/GAME_AUTHOR_GUIDE.md §2`.
  - `IPaymentHandlerMinimal` extended with `evaToken()` and `blacklist(address)`.
  - `IRandomProviderMinimal` extended with `requestRandomNumber(uint256)`, `getRequestStatus(uint256)`, and the three `FAILURE_*` constants.
  - Crash-local `IPaymentHandler` and `IRandomProvider` deleted; Crash now imports the platform interfaces directly.
  - Dead `ManualCashoutRecorded` declaration removed from `ICrashGame.sol` (was never emitted).

### Event additions / changes (breaking for indexers)

These change the on-chain event surface and require indexer updates before consuming a deployment built from this branch.

**Core**

- `BaseGame.setPaymentHandler` now emits `PaymentHandlerUpdated(address indexed oldHandler, address indexed newHandler)`. Previously silent.
- `BaseGame.emergencyWithdraw` event extended: `EmergencyWithdraw(address indexed to, uint256 amount, uint256 lockedExposureCleared)`. The new `lockedExposureCleared` field captures the pre-call `lockedExposure` value (zeroed as part of the platform invariant).
- `ProgressiveJackpot.setPaymentHandler` now emits `PaymentHandlerUpdated(address indexed oldHandler, address indexed newHandler)`. Previously silent.
- `ProgressiveJackpot.emergencyWithdraw` now emits `JackpotEmergencyWithdraw(address indexed to, uint256 amount, uint256[] tierPotsCleared, uint256 consolationPotCleared)`. Previously silent.
- `RandomProvider.setKeyHash` now emits `KeyHashUpdated(bytes32 oldKeyHash, bytes32 newKeyHash)`. Previously silent.

**Crash**

- `RoundRevealed` signature changed from `(uint256 indexed roundId, bytes32 serverSeed)` to `(uint256 indexed roundId, bytes32 serverSeed, uint32 crashPoint)`. Crash point is computed eagerly inside `revealSeed` (instead of lazily on first claim) so indexers can read the round's final multiplier directly from the log.
- `RoundSettled(uint256 indexed roundId, uint32 crashPoint, uint256 totalBetAmount, uint256 totalPayout)` is now actually emitted (was declared on the interface but never fired). Fires from `_settleRoundExposure` — the moment the operator submits total claimable payouts.

**Mines**

- `GameCanceled` signature changed from `(uint256 indexed requestId, address indexed player)` to `(uint256 indexed requestId, address indexed player, uint256 refundAmount)`. Non-zero `refundAmount` only when `cancelExpired` is called with `refundPlayer=true`; implicit start-of-new-game cancels emit `refundAmount = 0`.

**Slots**

- `SpinFailed` signature changed from `(uint256 indexed requestId, address indexed player, bytes32 reason)` to `(uint256 indexed requestId, address indexed player, bytes32 reason, uint256 refundAmount)`. Slots refunds `netStake` on VRF failure; the refund amount is now in the event.

### Storage layout

- `ProgressiveJackpot` removed `mapping(address => uint256[]) playerEntries`. Per-player history is now exclusively reconstructable from `EntryProcessed` events via an off-chain indexer; the on-chain mapping grew unboundedly and made `getPlayerEntries(player)` queries increasingly expensive. `getPlayerEntries(address)` function removed. `getEntry(uint256)` and the `entryHistory` mapping remain.

### Bug fixes

- **`RandomProvider.requestRandomNumber` regression** — an unstaged change had added `|| maxNumber > type(uint128).max` to the validation. This silently broke `CrashGame.createRound` which passes `type(uint256).max` (Crash uses `getRawWord` and doesn't need a range cap). Reverted to the HEAD-committed behavior. The `uint128` cast on the next line already handles oversized values via truncation.

### Coverage

- All foundation mixins (`BaseGame`, `Multicallable`, `SignedActionAuth`, `GameLifecycleRoles`, `VRFGameBase`, `JackpotClient`, `PushVRFGame`, `PullVRFGame`, `OperatorGame`), all core contracts (`AuthHub`, `PaymentHandler`, `RandomProvider`, `MultiLevelReferral`, `ProgressiveJackpot`), and the token now sit at 100% line / 100% statement coverage. Achieved partly through the addition of test-only harness contracts under `contracts/test/mocks/` (`AuthHubHarness`, `BaseGameHarness`, `PullVRFGameHarness`, `SignedActionAuthHarness`, `MockJackpotGame`, `ProgressiveJackpotHarness`) that expose internal functions or defensive branches unreachable through public APIs.
- Standing coverage gap: `CrashGame` (~52% line / ~27% statement), `CrashMathLib` (~6%), `MerkleClaimLib` (0%). Deferred for a dedicated test pass.

### Scripts

- New `scripts/testnet/deploy-core.ts` deploys only the platform core (no games). Output at `deployments/<network>-core.json`. Designed for new game teams to plug a single game into a fresh environment without deploying every existing game.
- `scripts/testnet/lib.ts` extended with `CoreContracts` / `CoreDeployment` types and `saveCoreDeployment` / `loadCoreDeployment` helpers.
- `.env.example` added documenting every required env var with sourcing notes.

### Documentation

- New `docs/DELEGATED_AUTH.md` — end-to-end guide for the operator backend (session keys, EIP-712 payload shape, `*For` flow, batching, error semantics, operational guidance).
- New `docs/INDEXER_GUIDE.md` — event catalog structured core → base → shape → game, with subgraph entity model and recommendations for new-game authors.
- `docs/ARCHITECTURE.md` refreshed: added `Multicallable` mixin entry, updated `GameLifecycleRoles` to mention `_verifyOperatorAttestation`, added §9 "Canonical interfaces (mandate)" section.
- `docs/GAME_AUTHOR_GUIDE.md` refreshed: new §2 "Canonical interfaces (the rule)", new §6 "Operator-relayed batching (`multicallTry`)", new pitfalls (interface redefinition, multicallTry gas hint), new testing-checklist section for batched delegated execution.
- `README.md` rewritten testnet workflow with dual-path A (new game team) and B (platform team).
- This `CHANGELOG.md` started.

### Infrastructure (this PR)

- `CONTRIBUTING.md` added.
- `.github/workflows/test.yml` added — compile + tests + Slither on every PR.
- `scripts/mainnet/deployments/index.json` added — single manifest indexing every game-version to deployment-artifact mapping for the indexer team.

---

## Older history

V1–V5 mainnet deployments live in `scripts/mainnet/deployments/arb-mainnet-v1..v5.json` plus per-game files (`plinko-mainnet-v5.json`, `crash-mainnet.json`, `lottery-mainnet.json`). Each carries its own `deployedAt`, `version`, and config notes — that's the authoritative record for historical addresses. The `scripts/mainnet/deployments/index.json` manifest references them.
