# Contributing to The Burning Games — Contracts

This document covers the workflow and standards for contributing to the platform contracts repo. Read it before opening your first PR — most reviewer feedback maps directly to rules below.

For background on the platform itself, read these first (in order):

1. [README.md](./README.md) — setup, testnet workflow, repo orientation
2. [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — platform overview, contract layers, money/auth/randomness flow
3. [docs/GAME_AUTHOR_GUIDE.md](./docs/GAME_AUTHOR_GUIDE.md) — practical guide for writing a new game
4. [docs/INDEXER_GUIDE.md](./docs/INDEXER_GUIDE.md) — events catalog (relevant to anyone shipping a new game — see §8)
5. [docs/DELEGATED_AUTH.md](./docs/DELEGATED_AUTH.md) — operator/backend integration

---

## Branch + PR workflow

- **Branch from `main`.** Use descriptive prefixes:
  - `game/<name>` — adding or modifying a game contract (e.g. `game/blackjack`)
  - `core/<feature>` — changes to the core platform (PaymentHandler, AuthHub, MLR, RandomProvider, ProgressiveJackpot, token)
  - `base/<feature>` — changes to the foundation mixins (BaseGame, Multicallable, shape bases, etc.)
  - `docs/<area>` — docs-only changes
  - `fix/<short-description>` — bug fixes
  - `chore/<task>` — tooling, CI, deployment script updates
- **One concern per PR.** A PR adding a new game shouldn't also refactor PaymentHandler. Split.
- **PR descriptions describe the WHY.** What the change accomplishes; what the alternative was; any deliberate trade-offs. The diff already shows the WHAT.
- **Sync `docs/` in the same PR as the contract change.** A game contract that lands without its `INDEXER_GUIDE.md §4` entry is incomplete (see [Mandatory documentation](#mandatory-documentation) below).

---

## Mandatory documentation

Every PR that touches contracts must keep the following in sync. The reviewer will check these:

| Change | Docs that must be updated in the same PR |
|---|---|
| New game added | `INDEXER_GUIDE.md §4` (game-specific events), `INDEXER_GUIDE.md §5` (envelope `data` schema), `GAME_AUTHOR_GUIDE.md §10` (envelope `data` schema mirror) |
| New event added on an existing game | `INDEXER_GUIDE.md §4` entry for that game |
| Event signature changed | `INDEXER_GUIDE.md` + `CHANGELOG.md` entry flagging the breaking change |
| Canonical interface extended (`IPaymentHandlerMinimal`, `IRandomProviderMinimal`, etc.) | `ARCHITECTURE.md §9` + `GAME_AUTHOR_GUIDE.md §2` |
| New shape base added | `ARCHITECTURE.md §4` + `GAME_AUTHOR_GUIDE.md §1` |
| Public function added or removed | NatSpec on the function + `CHANGELOG.md` entry |
| Deployment script change | Reflected in the docs that reference the script (`README.md` testnet section primarily) |

A PR missing one of these is incomplete. The bar isn't "the contract works" — it's "the next person consuming this knows it exists."

---

## Coding standards

### Canonical interfaces (the rule)

**Every interaction between a game and a platform contract goes through an interface declared under `contracts/interfaces/`.** Redefining these in your game folder is forbidden.

If the canonical interface doesn't expose a function you need, **add it to the canonical interface in the same PR**. Don't write a parallel ABI in your game folder. Reasoning:

- Single source of truth — interface changes propagate to every consumer automatically.
- Audit clarity — reviewers grep one path, not parallel ABI definitions per game.
- Forward compatibility — if the platform extends a contract, your game sees the new functions for free; redefined interfaces silently miss them.

Crash made this mistake historically (declared its own `IPaymentHandler` and `IRandomProvider`); the lesson got encoded as the rule. See `ARCHITECTURE.md §9` for the canonical list.

### No silent state mutations

**Every public state-changing function must emit an event.** This is not negotiable.

Concrete cases to watch for:
- New setter functions (`setFoo(...)`) — always emit `FooUpdated(old, new)`. Old + new value pair is preferred over new-only.
- New player-facing actions — emit at least one platform event documenting the action.
- Emergency / admin paths — emit, even if the path is "supposed to be rare." Especially then.
- ERC20 approvals via `safeApprove` — those produce the standard `Approval` event, which is fine. The platform-level intent (e.g. "PaymentHandler changed") still needs its own event.

Recent silent-setter regressions (`BaseGame.setPaymentHandler`, `ProgressiveJackpot.setPaymentHandler`, `RandomProvider.setKeyHash`) were caught and fixed; the pattern is established. Don't reintroduce it.

### Naming conventions

| Symbol | Convention | Example |
|---|---|---|
| Contracts | `PascalCase` | `MinesGameHybrid`, `BaseGame` |
| Functions (external + internal) | `camelCase` | `placeBetFor`, `_verifyAndConsume` |
| Internal helpers | Leading underscore | `_collectBet`, `_unlockExposure` |
| Events | `PascalCase`, past-tense or noun phrase | `BetPlaced`, `RoundSettled`, `PaymentHandlerUpdated` |
| Errors (custom errors) | `PascalCase`, noun phrase | `LiquidityShortfall`, `InvalidNonce`, `WrongGame` |
| Constants | `SCREAMING_SNAKE_CASE` | `MAX_BPS`, `TOTAL_SPOTS`, `START_GAME_TYPEHASH` |
| Storage variables | `camelCase` | `lockedExposure`, `actionNonces` |
| State mappings | `camelCase`, suffix with descriptor when ambiguous | `gameOperators`, `pendingBets` |
| Function parameters | `camelCase`, no leading underscore | `address player`, `uint256 wager` |

For events: include `indexed` on actor fields (player, game, operator, recipient, requestId) up to the three-topic limit. Indexed `uint256` IDs (`requestId`, `roundId`, `betId`) are preferred over non-indexed where possible.

### Use existing primitives

Before writing new bankroll / exposure / pause / approval logic, read [BaseGame.sol](./contracts/games/base/BaseGame.sol). The shape bases already provide:

- `_collectBet` / `_processBet` / `_collectAndProcessBet` / `_payPlayer` for the V5 payment flow
- `_lockExposure` / `_unlockExposure` / `availableLiquidity()` for bankroll solvency
- `pause` / `unpause` / `emergencyWithdraw` (non-virtual platform invariant — do NOT override)
- `multicallTry` (inherited from `Multicallable`) for operator batching

If you find yourself reimplementing one of these, stop and inherit instead.

### Required `*For` shape

Every game's delegated entry follows the canonical template documented in `GAME_AUTHOR_GUIDE.md §3.1`:

```solidity
function placeBetFor(
    address player,
    /* game-specific fields */,
    uint256 nonce,
    uint256 deadline,
    bytes calldata signature
) external onlyOperator nonReentrant returns (uint256) {
    bytes32 structHash = keccak256(abi.encode(
        TYPEHASH,
        address(this),       // MUST be the first field after the typehash — cross-game replay defense
        player,
        /* game-specific fields */,
        nonce,
        deadline
    ));
    _verifyAndConsume(player, address(this), wagerAmount, structHash, deadline, nonce, signature);
    return _placeBetInternal(player, /* game-specific fields */);
}
```

The typehash MUST start with `address game` as the first field. The internal helper uses `bettor` (the parameter passed in), never `msg.sender`. See `GAME_AUTHOR_GUIDE.md §9` for the common pitfalls list.

### Reentrancy + nonReentrant

- Every state-changing external function that moves tokens or makes external calls must be `nonReentrant`. The shape bases give you `ReentrancyGuard` through `BaseGame` — use the `nonReentrant` modifier.
- The one intentional exception is `multicallTry` itself, which is non-reentrant by virtue of each sub-call independently acquiring + releasing the guard. Don't add `nonReentrant` to `multicallTry`.

---

## Testing

Tests are required. The exact coverage targets are a topic of ongoing platform discussion — for now: **a PR without tests will be sent back, but there's no hard percentage gate.** What's expected:

- **Happy paths** for every new external function (direct + delegated where applicable)
- **Every revert path** (validation, access control, deadline, nonce, signature, etc.)
- **Lifecycle paths** (cancel, refund, VRF failure, timeout — whatever applies to your game)
- **Event payload verification** — assert not just that events fire but that their fields are correct (the recent indexer-focused changes set the precedent)

Test files live alongside their concerns:

- `test/auth/` — AuthHub
- `test/core/` — PaymentHandler, RandomProvider, MultiLevelReferral, ProgressiveJackpot
- `test/games/base/` — foundation mixins (BaseGame, SignedActionAuth, GameLifecycleRoles, Multicallable, JackpotClient)
- `test/games/` — individual games (`<Game>.test.ts` for core surface, `<Game>.full.test.ts` for exhaustive)
- `test/libraries/` — pure libraries
- `test/integration/` — cross-contract end-to-end (`Platform.e2e.test.ts`, `MulticallTry.load.test.ts`)
- `test/coverage/` — targeted fillers for defensive branches reachable only via harnesses

Run:

```bash
npm test                         # full suite
npm run test:coverage            # with coverage report
npx hardhat test path/to/file.ts # single file
```

CI runs the full suite on every PR. A red CI is a hard blocker.

### Defensive branches

For unreachable defensive code (e.g. `require(addr != address(0))` on parameters that never come from external paths), prefer a **test harness** under `contracts/test/mocks/` that exposes the internal function publicly. The existing harnesses (`AuthHubHarness`, `BaseGameHarness`, `PullVRFGameHarness`, `SignedActionAuthHarness`, `ProgressiveJackpotHarness`) set the pattern. Mark harness contracts with a `NEVER deploy on a non-test network` comment in their NatSpec.

---

## Documentation tone

This is a multi-team repo. Some teams will read every doc, others will only read the file they're modifying. Calibrate accordingly:

- **NatSpec on every external function and event** — this is the API surface external teams consume. Explain WHEN it fires / what the params mean / what reverts can occur.
- **Inline comments only where the WHY is non-obvious.** Don't comment `// increment counter` next to `counter++`. Do comment `// We intentionally compute crashPoint here rather than lazily so it lands in the RoundRevealed event for indexers.`
- **Reference other docs via relative links.** When a contract has a corresponding section in `INDEXER_GUIDE.md` or `GAME_AUTHOR_GUIDE.md`, the NatSpec should link there.

---

## Static analysis

We run [Slither](https://github.com/crytic/slither) in CI on every PR (`.github/workflows/test.yml`). Slither is a static-analysis tool by Trail of Bits that scans for ~80 known Solidity bug patterns. Local invocation:

```bash
pip install slither-analyzer
slither contracts/
```

Findings at `high` severity must be addressed before merging. `medium` / `low` / `informational` are reviewed case-by-case — many are false positives on safe patterns, but each one needs a deliberate "this is fine because X" comment in the PR.

---

## CI checklist (what runs on every PR)

The GitHub Actions workflow at `.github/workflows/test.yml`:

1. `npm ci` — install pinned dependencies
2. `npx hardhat compile` — must succeed
3. `npm test` — full test suite must pass
4. `slither contracts/` — must not surface new `high`-severity findings

Local equivalent before pushing:

```bash
npm ci && npx hardhat compile && npm test
slither contracts/  # optional, but CI will run it
```

---

## Operator key management (for external teams)

External game teams **do not manage the platform's AuthHub operator keys** — those stay centralized with the platform operator. If your game needs an operator backend, you'll get a registered operator address from the platform team that's pre-authorized on AuthHub.

For **per-game operator keys** (the `gameOperators` allowlist on your game contract that controls lifecycle ops like `createRound`, `revealSeed`, `resolveAbandoned`), the policy is currently per-game and will be standardized once the per-game backend pattern is defined. For now: use `setGameOperator` / `setGameOperators` to manage them, treat the same key as the AuthHub operator if simplest, and follow up with the platform team when you stand up your backend.

See [docs/DELEGATED_AUTH.md §2](./docs/DELEGATED_AUTH.md) for the distinction between AuthHub operators and game operators.

---

## Quick reference — what reviewers will check

A non-exhaustive list, in roughly the order issues surface:

- [ ] PR description explains the why
- [ ] Branch name follows the prefix convention
- [ ] One concern per PR
- [ ] Compile succeeds locally
- [ ] All tests pass (the CI check is the gate, but the local pre-push check should match)
- [ ] No silent state mutations — every state-changing public function emits
- [ ] No redeclarations of canonical interfaces
- [ ] Naming conventions followed
- [ ] `nonReentrant` on every external state-changing function that moves tokens or makes external calls
- [ ] `*For` typehash starts with `address game`
- [ ] NatSpec on every external function and event
- [ ] `INDEXER_GUIDE.md` updated for any new game / event / event-signature change
- [ ] `CHANGELOG.md` updated for breaking changes
- [ ] Slither high-severity clean

---

## Questions / proposals

This document represents the current consensus. If a rule here is blocking a legitimate use case, raise it as a discussion (or in your PR description) — rules are negotiable; silent deviations are not.
