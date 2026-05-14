# The Burning Games — Platform Architecture

The platform is a Web3 casino-game infrastructure on Arbitrum. Multiple game teams build on top of a shared base, audited and centrally administered. The architecture's job is to (1) make money flow auditable, (2) standardize identity and authentication, (3) keep game-team surface area small, and (4) make the patterns reviewable at a glance.

This document is the reference. The companion [GAME_AUTHOR_GUIDE.md](./GAME_AUTHOR_GUIDE.md) is the practical "how to build a game" walkthrough.

---

## 1. Layers

```
┌──────────────────────────────────────────────────────────────────────┐
│  GAMES                                                                │
│    PushVRFGame  → Plinko · Roulette · Slots · CrashGame              │
│    PullVRFGame  → Mines                                              │
│    OperatorGame → PaymentOnlyGameAdapter                             │
│    Bespoke      → TicketLottery (no token / no money flow)           │
└──────────────────────────────────────────────────────────────────────┘
                  ↑ inherits one of:
┌──────────────────────────────────────────────────────────────────────┐
│  SHAPE BASES (canonical inheritance points for game authors)         │
│    PushVRFGame · PullVRFGame · OperatorGame                          │
└──────────────────────────────────────────────────────────────────────┘
                  ↑ each composes:
┌──────────────────────────────────────────────────────────────────────┐
│  GAME MIXINS                                                          │
│    BaseGame · VRFGameBase · JackpotClient                            │
│    SignedActionAuth · GameLifecycleRoles · IGameEvents               │
└──────────────────────────────────────────────────────────────────────┘
                  ↑ talks to:
┌──────────────────────────────────────────────────────────────────────┐
│  CORE (singleton, admin-controlled)                                  │
│    EverValueCoin · AuthHub · PaymentHandler · MultiLevelReferral     │
│    RandomProvider · ProgressiveJackpot                               │
└──────────────────────────────────────────────────────────────────────┘
```

Every layer above the core is replaceable on redeploy. The core is shared infrastructure.

---

## 2. Core contracts

### `EverValueCoin` (EVA)
ERC-20 token, 21M max supply, burnable, OpenZeppelin 4.x. Already deployed to mainnet at `0x45D9831d8751B2325f3DBf48db748723726e1C8c`. The token is **immutable** — the platform never gets to choose a different token because the chain history is anchored on this address. No Permit support; players approve each game contract once per redeploy.

### `AuthHub`
Single source of truth for off-chain-signed-action authorization:
- **Player session keys** — each player authorizes one ephemeral signing key with optional expiration and optional cumulative spend cap. Used by games' `*For` entries.
- **Operator allowlist** — addresses that may relay player-signed actions on-chain. Compromise of an operator is bounded by: deadlines, nonces, session-key signatures, and spend caps.
- **Spend-tracker allowlist** — game contracts authorized to call `recordSpending` against player caps. Each `*For`-equipped game must be added here.
- **Max expiration delta** — optional ceiling on `expiresAt` to prevent never-expiring authorizations.

Domain: EIP-712 `BurningGamesAuthHub` v1.

### `PaymentHandler`
Inflow router for every bet on the platform. Slices each bet into:
- **house edge** → game's `feeRecipient`
- **referral cut** → MultiLevelReferral (then on to referrer chain)
- **jackpot share** → ProgressiveJackpot (via `addFunds`)
- **net stake** → game's `payoutTarget`

Also holds the **game registry** (every player-facing game must be registered), the **platform-wide jackpot pointer** (single admin tx swaps the jackpot for every game), and the **player access controls** (whitelist, blacklist, self-exclusion). Self-exclusion + blacklist are checked at bet inflow.

Configuration per game: `(payoutTarget, feeRecipient, houseEdgeBps, referralBps, jackpotBps)`. Constraint: `houseEdge + referral + jackpot ≤ 10_000` (no per-fee cap by design).

### `MultiLevelReferral` (MLR)
Multi-level referral graph + cumulative reward bookkeeping.

- **Levels** — admin sets a per-level bps array of up to 5 levels. Bps are **shares of the referral pool**, not absolute percentages. With `[7000, 2000, 1000]` and a single upline, that upline receives `4000/10000 = 70%` of the referral cut; the remaining 30% goes to the **fallback receiver**.
- **First-write-wins** — a player's referrer is locked the first time `recordReferral` runs for them. Admin can seed via `adminSetReferrers` only for players whose referrer is unset (no override path by design).
- **Cycle detection** — `_wouldCreateCycle` walks up the chain up to depth 32; cycles are blocked at both organic and admin assignment paths.
- **Payouts** — credited to `pendingRewards`; recipient calls `withdrawRewards()` to claim.
- **Emergency** — `emergencyWithdraw` drains the entire contract balance including pending rewards. Admin coordinates out-of-band reimbursement.

### `RandomProvider`
Chainlink VRF v2.5 wrapper, custom-built for the platform. Consumers call `requestRandomNumbers(ranges)`; the provider:
1. Sends one VRF request to the coordinator
2. On fulfillment, **stores the raw word** (publicly readable via `getRawWord(requestId)`)
3. Derives the requested per-range bounded values from the raw word using `RandomDeriveLib`
4. Attempts a push callback to `consumer.fulfillRandomness(...)`

Important: the push callback is wrapped in `try/catch`. A consumer that doesn't implement `fulfillRandomness` will silently fail; the raw word is STILL stored, so a pull-model consumer (Mines) can still settle. The `PullVRFGame` shape base supplies a no-op `fulfillRandomness` precisely to keep this clean and avoid wasting LINK on the catch path.

### `ProgressiveJackpot` (PJ)
Tiered jackpot with per-tier isolated pots + consolation pot.
- 9-tier ladder, configurable per-tier fixed cost
- Per-tier probability scaling (base, max, increment per entry)
- Two entry paths: **direct bet** (player → PJ) and **game entry** (game → PJ.processJackpotEntry when game wants to route a hit)
- Outcomes table per registered game: lose, consolation (multiplier), tier award
- Solvency check: `ensurePayable(game, betAmount)` verifies the tier pot covers max consolation before accepting a bet

PJ is a "game" from PaymentHandler's perspective (registered like any other) AND it integrates with games via `processJackpotEntry`.

---

## 3. Game mixins (composition primitives)

These are inherited indirectly via shape bases. Game authors don't compose them directly.

### `BaseGame`
The foundation. Provides:
- Immutable `evaToken`, mutable `paymentHandler`, persistent `lockedExposure`
- `_collectBet` / `_processBet` / `_collectAndProcessBet` — the V5 inflow pattern (player → game → handler → fee split)
- `_payPlayer` — outflow primitive
- `_lockExposure(maxPayout, jackpotContribution)` / `_unlockExposure(...)` — bankroll solvency tracking
- `availableLiquidity()` view (virtual — CrashGame overrides to also subtract `operatorBond`)
- `pause()` / `unpause()` (non-virtual, owner-only)
- `emergencyWithdraw(to, amount)` — **non-virtual platform invariant**: requires `whenPaused`, **always zeros `lockedExposure`**, regardless of amount. Games cannot override.
- `setPaymentHandler(newHandler)` — owner-only, revokes old approval + grants new
- Inherits `Ownable2Step`, `Pausable`, `ReentrancyGuard`

### `VRFGameBase`
Extends `BaseGame`:
- Immutable `randomProvider`
- `onlyRandomProvider` modifier
- Declares `IRandomConsumer` (forcing the implementer to provide `fulfillRandomness` + `handleRandomFailure`)

### `JackpotClient`
Read-through adapter for jackpot interaction. Reads the active jackpot from PaymentHandler — a single admin tx swaps the jackpot platform-wide.
- `_jackpotRollCap()` — probability precision
- `_enterJackpot(player, betAmount, roll)` — call PJ.processJackpotEntry
- `_ensureJackpotPayable(betAmount)` — solvency precheck

Requires the inheriting contract to implement `_paymentHandler()` (the shape bases provide this).

### `SignedActionAuth`
The `*For` (operator-relayed) authentication pattern.
- Immutable `authHub` reference
- Per-player `actionNonces` (local to each game contract)
- `onlyOperator` modifier — checks AuthHub.isOperator on `msg.sender`
- `_verifyAndConsume(player, game, betAmount, structHash, deadline, nonce, signature)` — the canonical verification path: game-binding check, deadline, nonce, session-key signature, spend-cap charge, nonce increment

EIP-712 domain (`name`, `version`) is per-game, supplied to the constructor. Each typehash MUST include `address game` as the first field after the typehash name.

### `GameLifecycleRoles`
Per-game operator allowlist + `onlyGameOperator` modifier. **Distinct from AuthHub.isOperator** — the latter authorizes signature relay across all games, this authorizes game-specific lifecycle operations (round creation, oracle attestation, lottery batch submission, etc.). Same backend wallet typically holds both, managed independently.

Also exposes `_verifyOperatorAttestation(messageHash, signature)` — a helper for games that accept off-chain ECDSA attestations from any allowlisted operator (used by Mines's click-outcome signatures, for example). Recovers the signer against `toEthSignedMessageHash` and asserts it's on `gameOperators`. This is the unified replacement for per-game `oracleSigner` setups.

### `Multicallable`
Best-effort batch executor for relayed `*For` actions. Inherited by `BaseGame` (so every game gets it) AND by `ProgressiveJackpot` directly.

`multicallTry(bytes[] calldata data) returns (bool[] successes, bytes[] results)` — DELEGATECALLs each entry against the contract itself. A reverting sub-call rolls back its own state and emits `MulticallSubCallFailed(index, returnData)`; iteration continues so one bad action doesn't grief the whole batch (e.g. a stale-nonce sub-call from one player no longer aborts every other player in the operator's bundle).

Gated by an abstract `_multicallAuthorized(address caller)` hook the inheriting contract MUST implement. The shape bases (`PushVRFGame`, `PullVRFGame`, `OperatorGame`) and `ProgressiveJackpot` all implement it as `authHub.isOperator(caller)`, so the gate tracks the same allowlist used by every `*For` entry. A game wanting a stricter policy can override further.

**Why operator-only, not permissionless**: every sub-call enforces its own ACL anyway, so a permissionless wrapper would still be safe, but: indexers want `multicallTry` txs to mean "one operator tick"; non-operator callers could spam `MulticallSubCallFailed` events; surface-area minimization. Games that want player-side batching should expose a dedicated entry rather than open `multicallTry`.

### `IGameEvents`
The standardized event envelope:
- `BetPlaced(uint256 indexed requestId, address indexed player, uint256 amount, bytes data)`
- `BetSettled(uint256 indexed requestId, address indexed player, uint256 payout, bytes data)`
- `BetFailed(uint256 indexed requestId, address indexed player, bytes32 reason)`

The `bytes data` blob holds game-specific outcome details ABI-encoded per a documented schema. Every shape base inherits this, every game emits it alongside their game-specific events.

---

## 4. Shape bases (canonical inheritance points)

Three pre-composed bundles that cover the realistic game shapes.

### `PushVRFGame`
For games where the VRF callback settles the bet inline. The 80% case.

Inheritance: `VRFGameBase + JackpotClient + SignedActionAuth + GameLifecycleRoles + IGameEvents`

Used by: Plinko, SingleRandomRoulette, MultiLineSlots.

### `PullVRFGame`
For games where settlement happens AFTER VRF lands (commit-reveal, multi-step state machines). The game reads `getRawWord(requestId)` at settle time, not in a callback.

Inheritance: same as PushVRFGame, with two key additions:
- Non-overridable no-op `fulfillRandomness` — prevents the LINK leak from RandomProvider's push attempt
- `_readRandomWord(requestId)` helper — reads via `IRandomProviderPullReader`

Used by: MinesGameHybridV2.

### `OperatorGame`
For games without on-chain randomness. Operator settles based on off-chain outcome.

Inheritance: `BaseGame + SignedActionAuth + GameLifecycleRoles + IGameEvents`. **No VRFGameBase, no JackpotClient.**

Used by: PaymentOnlyGameAdapter.

### Why not one base for everything?

A single state machine doesn't fit all games. Push-style fits Roulette but not Mines. Operator-style fits TicketLottery but not Plinko. The three shape bases capture the realistic shapes; if a game's mechanics truly don't fit any of them (no full-stack game in the current platform falls here — CrashGame is on PushVRFGame), the team can inherit the mixins directly.

### Patterns are not shape bases

Shape bases are **mechanical** — they bundle inheritance and define what `fulfillRandomness` does. Game *patterns* — the trust model, the state machine, the settlement timing — are conceptual and may cut across multiple shape bases. The clearest example is the **attested-VRF pattern**:

> **Attested-VRF pattern** — VRF establishes unbiasable randomness, a trusted server (a registered `gameOperator`) provides a second resolution layer translating randomness into a specific outcome, and claim depends on the server's output.
>
> Both games derive their server-side trust authority from the same source: the `gameOperators` allowlist on `GameLifecycleRoles`. The cryptographic primitive used to express that authority differs:
>
> - **Mines** (on `PullVRFGame`) — after VRF lands (no-op callback) and the player commits to clicks, an operator signs `(requestId, secret, clicks)` with a standard `personal_sign` ECDSA signature. The player's `claim` calls `_verifyOperatorAttestation`, which recovers the signer and asserts it is on `gameOperators`. Then it verifies the click commit and the secret-commit pre-image, and resolves the outcome.
> - **CrashGame** (on `PushVRFGame`) — before betting opens, an operator commits `keccak256(serverSeed)` via an `onlyGameOperator` call. After VRF lands (callback stores the word on the round), the operator reveals `serverSeed` (also `onlyGameOperator`). The crash point is computed deterministically from `(vrfWord || serverSeed || roundId)`.
>
> The pattern is shared: VRF + operator-resolved outcome + delayed claim. The mechanics differ — Mines uses an ECDSA attestation (claim is player-driven, operator only signs), CrashGame uses a hash commit-reveal (operator submits txs that gate progression) — but both authorities ultimately resolve through the same allowlist. Rotating an operator (via `setGameOperator`) atomically rotates the address that can sign Mines attestations *and* call CrashGame lifecycle. New attested-VRF games inherit the same allowlist via `GameLifecycleRoles` and pick whichever primitive (ECDSA attestation or commit-reveal) suits their flow.

---

## 5. Actors and trust model

Five distinct roles:

| Role | Holds | Trust scope | Who runs it |
|---|---|---|---|
| **Player** | Wallet, funds, self-exclusion power | The platform's customer | End user |
| **Session key** | Ephemeral signing key, no funds | Per-player, spend-capped, expirable | Player's frontend / wallet |
| **Operator** | On-chain wallet, AuthHub-allowlisted, pays gas | Per-game or platform-wide; bounded by signatures + spend cap + nonce | Platform backend |
| **Oracle signer** | Off-chain signing key (e.g. for Mines click attestation) | Per-game | Platform backend or HSM |
| **Owner** | Cold multisig | Sets allowlists, configures economics, can pause everything | Platform multisig |

The "operator" concept appears in **two distinct contracts** that should not be conflated:

- **AuthHub.isOperator** — "may relay player-signed actions across any game". Allowlist managed centrally.
- **GameLifecycleRoles.gameOperators** — "may run THIS game's lifecycle". Per-game allowlist managed by each game's owner.

Same backend wallet typically holds both authorizations, but they're stored and revoked separately. Compromise of one doesn't blast-radius into the other.

---

## 6. Money flow

```
                            ┌────────────────────┐
                            │  PaymentHandler    │
                            │  (chokepoint)      │
                            └─────────┬──────────┘
                                      │
   ┌────── house edge ─────────────►  │
   │                                  │
   │   ┌── referral fee ─────────►    │   ──► MultiLevelReferral
   │   │                              │      (then to referrer chain)
   │   │   ┌── jackpot share ──►      │   ──► ProgressiveJackpot
   │   │   │                          │      (addFunds)
   │   │   │   ┌── net stake ──►      │   ──► Game's bankroll
   │   │   │   │                      │
   │   │   │   │                      └──────►  Game.payoutTarget
   │   │   │   │                                  (typically the game itself)
   │   │   │   │
[fees]                              [bet]
   │   │   │   ▲
   │   │   │   │
   │   │   │   └── transferFrom(player → game)
   │   │   │
   │   │   └─── routed by PaymentHandler.processDirectBetFromGame()
   │   │
   │   └─── recorded by MLR (referrer assignment + pendingRewards accrual)
   │
   └─── transferred to game.feeRecipient
```

Outflows (player payouts) happen **directly** from the game contract to the player. PaymentHandler is inflow-only. This keeps the chokepoint cleaner: every bet's fee split is visible in one `GameBetProcessed` event from PaymentHandler.

### Game bankroll

Each game holds its own EVA bankroll. Net stakes accrue, payouts are deducted. `_lockExposure(maxPayout, jackpotShare)` reserves the worst-case payout against the balance; the game can't accept a bet whose worst case it can't pay. Custom locking math (Mines's coverage-fraction, Plinko's per-bet cap, Crash's per-round model) writes to the **same** `lockedExposure` variable inherited from BaseGame.

### Emergency exit

`emergencyWithdraw(to, amount)`:
- Owner-only, `whenPaused` enforced
- Always zeros `lockedExposure` (platform invariant)
- Non-overridable
- Pending bets must be reconciled out-of-band by the admin

---

## 7. Randomness model

### Push (Roulette, Slots, Plinko, ProgressiveJackpot)
```
game.placeBet()
  → RandomProvider.requestRandomNumbers(ranges)
  → Chainlink VRF coordinator (off-chain)
  → RandomProvider.fulfillRandomWords (called by coordinator)
  → game.fulfillRandomness(requestId, randomWord, derivedValues)
  → game pays player, emits BetSettled
```

The whole settle happens inline in the callback.

### Pull (Mines)
```
game.startGame()
  → RandomProvider.requestRandomNumbers(ranges)
  → Chainlink VRF coordinator
  → RandomProvider.fulfillRandomWords (stores rawWord, no-op call to game)
  → ...player takes additional actions (commitToClicks)...
  → game.claim()
    → reads RandomProvider.getRawWord(requestId)
    → verifies oracle attestation
    → resolves outcome, pays player, emits BetSettled
```

Pull is for state machines where the player decides AFTER VRF has fired but BEFORE settlement. Card games, dynamic-choice games, commit-reveal games. Mines is the canonical example.

### Operator-driven (TicketLottery, PaymentOnlyAdapter, CrashGame)
Either uses VRF via the coordinator directly (TicketLottery) or doesn't use VRF at all (PaymentOnlyAdapter, CrashGame's per-round commit-reveal hybrid). Settlement is operator-initiated.

---

## 8. Event envelope

Every game emits two parallel events at each lifecycle transition:

1. **Game-specific detailed event** — e.g. `SpinResolved(requestId, player, outcome, payout, spinsConsumed, jackpotPayout)` on Roulette. Rich, decoded fields useful for game-specific dashboards and debugging.

2. **IGameEvents envelope event** — e.g. `BetSettled(requestId, player, payout, bytes data)`. Same `requestId`, same `player`, same `payout`, but game-specific outcome details are ABI-encoded into `data`.

Indexers and cross-game analytics consume the envelope events (one schema regardless of which game emitted). Game-specific dashboards consume the detailed events. Both coexist; gas overhead is one extra LOG opcode per bet.

Per-game `data` schemas are documented in [GAME_AUTHOR_GUIDE.md](./GAME_AUTHOR_GUIDE.md#event-data-schemas).

---

## 9. Canonical interfaces (mandate)

Every interaction between a game and a platform contract goes through an interface declared under `contracts/interfaces/`. **Games MUST import these; redeclaring them in the game's own folder is forbidden.** If a function you need isn't on the canonical interface, the fix is to add it to the canonical interface — not to ship a parallel ABI.

Rationale: single source of truth for interface evolution; auditors can grep one place; future games inherit changes automatically; no silent ABI drift between games.

The complete consumer-side interface list:

| Interface | Path | Purpose |
|---|---|---|
| `IPaymentHandlerMinimal` | `contracts/interfaces/core/IPaymentHandlerMinimal.sol` | Bet routing, fee splits, jackpot lookup, EVA discovery, blacklist |
| `IRandomProviderMinimal` | `contracts/interfaces/core/IRandomProviderMinimal.sol` | VRF requests (single or range), status, failure tags |
| `IRandomProviderPullReader` | `contracts/interfaces/core/IRandomProviderPullReader.sol` | Pull-model `getRawWord(requestId)` (pull-shape games only) |
| `IRandomConsumer` | `contracts/interfaces/core/IRandomConsumer.sol` | Callback signature the provider invokes on the game (game implements this) |
| `IProgressiveJackpot` | `contracts/interfaces/core/IProgressiveJackpot.sol` | Jackpot entry + payable precheck (consumed via `JackpotClient` — games rarely import directly) |
| `IAuthHub` | `contracts/interfaces/auth/IAuthHub.sol` | Operator allowlist, session keys, spend caps (consumed via `SignedActionAuth`) |

Game-shape inheritance (via `PushVRFGame` / `PullVRFGame` / `OperatorGame`) wires these for you. If you find yourself writing a new `interface IFoo` for a platform contract, stop — the canonical version exists.

---

## 10. What's centralized vs per-game

### Centralized (platform multisig)
- AuthHub state (operator allowlist, spend tracker allowlist, max expiration)
- PaymentHandler state (game registry, fee splits, jackpot pointer, whitelist, blacklist, self-exclusion)
- ProgressiveJackpot economics (tier ladder, probability config, outcomes per game)
- RandomProvider state (key hash, subscription ID, allowed consumers)
- MultiLevelReferral state (levels, fallback receiver)
- The token (EverValueCoin) — immutable

### Per-game (game's `owner`)
- Game configuration (table configs, multiplier tables, bet limits, payout multipliers)
- Per-game operator allowlist (`GameLifecycleRoles.gameOperators`) — same allowlist also doubles as the trust set for any ECDSA attestations the game accepts (e.g. Mines's click-outcome signatures, via `_verifyOperatorAttestation`)
- Pause / unpause / emergencyWithdraw for the specific game
- PaymentHandler reference (can be swapped, although the platform typically uses one PH)

The platform multisig is typically also the `owner` of each game, but the separation lets a game be transferred to a sub-admin (e.g. a launch partner) without giving them platform-wide power.

---

## 11. What's deliberately NOT in the platform

These have been discussed and intentionally rejected:

- **Proxy / upgradeability patterns** — platform redeploys games clean; players re-approve. No storage-layout discipline, no init dance, no upgrade hooks.
- **Migration helpers** — game retirement is manual: pause, drain bankroll via `emergencyWithdraw`, deploy new version, players re-approve.
- **EIP-2612 Permit** — the token is immutable and doesn't support Permit. Players approve each new game contract.
- **Per-fee MAX_BPS caps** — admin must be able to set 90%+ house edge if a future game's economics require it.
- **Timelocks on admin actions** — handled at the multisig layer, not in the contracts.
- **Auto-refunds on VRF failure** — every game decides its policy. Some refund (Roulette, Slots), some don't (Plinko, Mines). Admin handles broken bets via off-chain analysis.
- **Self-exclusion check on outflow** — exclusion is enforced at bet inflow only. A self-excluded player whose bet was placed before exclusion still receives any payout from it (the only realistic case).
- **Platform-wide pause** — call `pause()` on each game individually if needed. No PaymentHandler-level kill switch.
- **Event continuity tooling / version registry** — game discovery is via the deployment artifacts (`scripts/mainnet/deployments/*.json`), not on-chain.
- **CI checklist enforcement** — deferred; review velocity is currently a manual checklist.

---

## 12. Where to look next

- [GAME_AUTHOR_GUIDE.md](./GAME_AUTHOR_GUIDE.md) — practical guide for writing a new game
- [probability_model.md](./probability_model.md) — probability scaling math (legacy V4, still applicable)
- [GAME_INTEGRATION_GUIDE.v5-legacy.md](./GAME_INTEGRATION_GUIDE.v5-legacy.md) — predecessor doc, retained for historical context. Superseded by GAME_AUTHOR_GUIDE.md.
- `scripts/mainnet/deployments/` — deployment artifacts for the current mainnet contracts
- `scripts/testnet/` — testnet deploy + interaction scripts (Arbitrum Sepolia)
