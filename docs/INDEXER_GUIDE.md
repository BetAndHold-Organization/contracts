# Indexer Guide

**Audience.** Authors of the indexer / subgraph / backend that consumes platform events to reconstruct state, serve clients, and build dashboards. This doc inventories every event the production contracts emit, structured from the broadest (core platform) down to the most specific (per-game lifecycle).

Conventions:
- `indexed` parameters are filterable via log topics (max 3 per event).
- `bytes data` payloads use ABI encoding with a per-game schema — schemas are documented inline below and (for envelope events) also in [GAME_AUTHOR_GUIDE.md §10](./GAME_AUTHOR_GUIDE.md).
- Every event below was inventoried against the contracts at the time of writing. The source of truth is the deployed bytecode's ABI.

---

## 0. The three-layer event story

The platform emits at **three layers** for every player bet:

1. **Core layer** — `PaymentHandler`, `AuthHub`, `MultiLevelReferral`, `RandomProvider`, `ProgressiveJackpot`. Every game routes through these. The events here describe the platform-level money/auth/randomness flow and are emitted regardless of which game produced the bet.
2. **Game-envelope layer** — `IGameEvents` (`BetPlaced` / `BetSettled` / `BetFailed`). Every game emits these as a canonical lifecycle signal. `requestId` is the join key — same value as the VRF request ID for VRF-driven games, or a sequential bet ID for off-chain games.
3. **Game-specific layer** — each game also emits its own richer events (e.g. `SpinStarted`, `GameStarted`, `RoundCrashed`). Dual-emit pattern: the envelope event AND the game-specific event fire from the same call, so indexers can choose granularity.

For most indexer use cases the recipe is: subscribe to envelope events for cross-game queries (leaderboards, total volume, player history), subscribe to game-specific events for per-game dashboards (Roulette outcome distribution, Crash multiplier history).

The diagram for a single delegated bet:

```
Operator submits startSpinFor(player, …)
    │
    ├─→ AuthHub.SpendingRecorded(player, game, amount, newSpent)   ← layer 1 (core)
    ├─→ PaymentHandler.GameBetProcessed(game, bettor, ref, …)      ← layer 1 (core)
    ├─→ MultiLevelReferral.RewardCredited(…) × N levels            ← layer 1 (core, conditional)
    ├─→ SingleRandomRoulette.SpinStarted(requestId, player, …)     ← layer 3 (game-specific)
    └─→ IGameEvents.BetPlaced(requestId, player, amount, data)     ← layer 2 (envelope)

... VRF callback later ...

    ├─→ RandomProvider.RandomWordsFulfilled(requestId, …)          ← layer 1 (core)
    ├─→ SingleRandomRoulette.SpinResolved(requestId, player, …)    ← layer 3 (game-specific)
    └─→ IGameEvents.BetSettled(requestId, player, payout, data)    ← layer 2 (envelope)
```

---

## 1. Core layer events

### `AuthHub` — session keys + spend caps + operator allowlist

| Event | Signature | Fires when |
|---|---|---|
| `SessionKeyAuthorized` | `(address indexed player, address indexed sessionKey, uint64 expiresAt, uint128 spendCap)` | Player calls `authorize` (direct) or operator calls `authorizeFor` |
| `SessionKeyRevoked` | `(address indexed player, address indexed sessionKey)` | Player calls `revoke` |
| `SpendingRecorded` | `(address indexed player, address indexed game, uint256 amount, uint128 newSpent)` | A game (registered spend tracker) charges the player's session-key cap — fires once per `*For` `betAmount > 0` |
| `OperatorSet` | `(address indexed operator, bool status)` | Admin enables/disables an operator wallet |
| `SpendTrackerSet` | `(address indexed game, bool status)` | Admin enables/disables a game's right to record spending |
| `MaxExpirationDeltaSet` | `(uint64 delta)` | Admin updates the session-key expiration ceiling |

**Indexer hot spot.** `SpendingRecorded` is fired on every delegated bet AND on `ProgressiveJackpot.placeDirectBetFor` AND on `PaymentOnlyGameAdapter.playFor`. Per-player cumulative spend across the platform = sum of `SpendingRecorded.amount` filtered by player.

### `PaymentHandler` — bet routing + fee splits

| Event | Signature | Fires when |
|---|---|---|
| `GameBetProcessed` | `(address indexed game, address indexed bettor, address indexed assignedReferrer, uint256 baseCost, uint256 houseFee, uint256 referralFee, uint256 jackpotShare, uint256 netAmount)` | Every bet processed through the handler — both direct and *For. THIS IS THE FEE BREAKDOWN. |
| `GameRegistered` | `(address indexed game, address payoutTarget, address feeRecipient, uint16 houseEdgeBps, uint16 referralBps, uint16 jackpotBps)` | Admin registers a new game |
| `GameUpdated` | `(address indexed game, …same fields…)` | Admin re-registers (updates) an existing game's config |
| `GameStatusChanged` | `(address indexed game, bool enabled)` | Admin enables/disables a game |
| `JackpotSet` | `(address indexed jackpot)` | Admin points PaymentHandler at a new ProgressiveJackpot |
| `ReferralContractSet` | `(address indexed referralContract)` | Admin points PaymentHandler at a new MLR |
| `WhitelistStatusChanged` / `BlacklistStatusChanged` | `(bool enabled)` | Admin toggles whitelist or blacklist enforcement |
| `WhitelistUpdated` / `BlacklistUpdated` | `(address indexed account, bool value)` | Admin adds/removes a player from a list |
| `SelfExcluded` | `(address indexed account)` | Player self-excludes |

**Indexer hot spot.** `GameBetProcessed` is the canonical "money flowed" event. The five amount fields sum to `baseCost`. Use this for fee revenue dashboards, referral attribution, and jackpot funding analytics.

### `MultiLevelReferral` — referral graph + rewards

| Event | Signature | Fires when |
|---|---|---|
| `ReferrerRecorded` | `(address indexed player, address indexed referrer)` | Player's first bet with a non-zero `potentialReferrer` — referrer is locked in for this player from this point forward |
| `RewardCredited` | `(address indexed player, address indexed recipient, uint8 level, uint256 amount)` | Bet routed referral fees to an upline — fires once per level that received credit |
| `RewardsWithdrawn` | `(address indexed referrer, uint256 amount)` | Referrer claims accumulated rewards |
| `AdminReferralSeeded` | `(address indexed referee, address indexed referrer)` | Admin force-sets a referral edge (for migrations) |
| `LevelsUpdated` | `(uint8 levelCount, uint16[MAX_LEVELS] levelBps)` | Admin updates the upline split |
| `DefaultReceiverSet` | `(address indexed receiver)` | Admin updates the fallback recipient |
| `PaymentHandlerSet` | `(address indexed handler)` | Admin updates the handler reference |

**Indexer hot spot.** The referral graph is constructed by aggregating `ReferrerRecorded` events (one per player). Pending balances per referrer = sum(RewardCredited.amount) − sum(RewardsWithdrawn.amount).

### `RandomProvider` — VRF requests + fulfillment + failures

| Event | Signature | Fires when |
|---|---|---|
| `RandomWordsRequested` | `(uint256 indexed requestId, address indexed consumer, uint256 rangeCount, uint256 gasLimit, RandomDeriveLib.Range[] ranges)` | Game requests randomness |
| `RandomWordsFulfilled` | `(uint256 indexed requestId, uint256 randomWord, uint256[] derivedValues)` | VRF callback lands, derived values are computed |
| `RequestFailed` | `(uint256 indexed requestId, string reason)` | Timeout / consumer revert / consumer error |
| `FailureNotificationFailed` | `(uint256 indexed requestId, address indexed consumer, bytes32 failureTag, bytes reason)` | A failure path tried to call `consumer.handleRandomFailure` and that call itself reverted |
| `ConsumerStatusUpdated` | `(address indexed consumer, bool status, uint256 maxRanges)` | Admin enables/disables a game as a VRF consumer |
| `SubscriptionIdSet` | `(uint256 indexed subId)` | Admin updates the Chainlink subscription ID |
| `KeyHashUpdated` | `(bytes32 oldKeyHash, bytes32 newKeyHash)` | Admin updates the VRF key hash (gas lane) |
| `ConfigUpdated` | `(uint16 requestConfirmations, uint32 callbackGasLimitBase, uint32 extraGasPerWord)` | Admin updates VRF callback config |

**Indexer hot spot.** `requestId` joins `RandomWordsRequested` to the game's `BetPlaced` (same `requestId`) and `RandomWordsFulfilled` to the game's `BetSettled`. If a `RequestFailed` lands without a matching `BetFailed`, your handler-failure logic is broken on that game.

### `ProgressiveJackpot` — direct bets + tier progression

| Event | Signature | Fires when |
|---|---|---|
| `DirectBetRequested` | `(uint256 indexed requestId, address indexed player, uint256 amount, uint8 tierIndex)` | `placeDirectBet` / `placeDirectBetFor` — `amount` is the NET amount post-fees |
| `DirectBetSettled` | `(uint256 indexed requestId, address indexed player, uint8 outcomeIndex, uint256 payout)` | VRF lands and the direct bet resolves |
| `EntryProcessed` | `(uint256 indexed entryId, address indexed game, address indexed player, uint8 tierIndex, uint8 outcomeIndex, uint256 payout)` | ANY jackpot entry — both direct bets and other games' jackpot-roll path. **This is the primary per-player jackpot-history event.** |
| `TierWon` | `(uint8 indexed tierIndex, address indexed player, uint256 payout)` | Player won a tier prize |
| `JackpotWon` | `(address indexed player, uint256 payout)` | Player won a terminal-tier or terminal-reset jackpot |
| `ConsolationPaid` | `(address indexed player, uint256 payout, uint16 consolationMultiplier)` | Player won a consolation |
| `FundsAdded` | `(address indexed game, uint256 amount, uint256 newTotal)` | A game routed jackpot-share funds to PJ via PaymentHandler |
| `TierPotSeeded` | `(uint8 indexed tierIndex, uint256 amount)` | Admin seeds a tier pot |
| `ConsolationPotSeeded` | `(uint256 amount)` | Admin seeds the consolation pot |
| `AdminFundsDistributed` | `(address indexed admin, uint256 amount)` | Admin adds bulk funds distributed across pots |
| `PaymentHandlerUpdated` | `(address indexed oldHandler, address indexed newHandler)` | Admin updates the PH reference |
| `JackpotEmergencyWithdraw` | `(address indexed to, uint256 amount, uint256[] tierPotsCleared, uint256 consolationPotCleared)` | Admin emergency-drains the pots |
| **lifecycle / progression** | | |
| `LadderReset` / `TierLadderUpdated` / `TierSharesUpdated` / `TierProbConfigUpdated` / `TierProbabilityBoosted` / `TierProbabilityReset` / `ConsolationShareUpdated` / `ConsolationProbabilitiesUpdated` / `GameRegistered` / `GameUpdated` / `GameStatusChanged` / `DirectBetConfigured` / `AdminStatusChanged` | various | Admin config updates |

**Indexer hot spot.** `EntryProcessed` is the canonical per-player jackpot history. **Per-player entry history is NOT indexed on-chain anymore** — the platform deliberately dropped the `playerEntries[]` array to keep storage bounded; reconstruct it from this event stream.

### `EverValueCoin` — ERC20

Standard ERC20 events (`Transfer`, `Approval`). Burns emit `Transfer(addr, address(0), amount)`. Nothing platform-specific to add.

---

## 2. Base / mixin layer — events every game inherits

These are emitted by every game contract because every game inherits from `BaseGame` (and via the shape bases, from `Multicallable` + `GameLifecycleRoles` + `IGameEvents`).

### `BaseGame`

| Event | Signature | Fires when |
|---|---|---|
| `PaymentHandlerUpdated` | `(address indexed oldHandler, address indexed newHandler)` | Admin swaps the game's PaymentHandler reference |
| `EmergencyWithdraw` | `(address indexed to, uint256 amount, uint256 lockedExposureCleared)` | Owner emergency-drains the game's bankroll. **`lockedExposureCleared` captures the pre-call `lockedExposure` value** (platform invariant — emergency withdraw always zeros it). |

OZ `Pausable` also emits `Paused(address)` / `Unpaused(address)` — filter by the emitting contract address to know which game was paused.

### `Multicallable`

| Event | Signature | Fires when |
|---|---|---|
| `MulticallSubCallFailed` | `(uint256 indexed index, bytes returnData)` | A sub-call inside `multicallTry` reverted — index is the position in the original batch, returnData is the raw revert payload |

### `GameLifecycleRoles`

| Event | Signature | Fires when |
|---|---|---|
| `GameOperatorSet` | `(address indexed operator, bool status)` | Owner enables/disables a per-game operator wallet (NOT the same as AuthHub.OperatorSet — see [DELEGATED_AUTH.md §2](./DELEGATED_AUTH.md)) |

### `IGameEvents` — the canonical envelope

Every game emits these three events on the bet lifecycle. **These are your single highest-value subscription** — they give you per-bet lifecycle visibility across the entire platform with a uniform schema.

| Event | Signature | Fires when |
|---|---|---|
| `BetPlaced` | `(uint256 indexed requestId, address indexed player, uint256 amount, bytes data)` | Bet placed. `requestId` = VRF request ID for VRF games, sequential bet ID for off-chain games. `amount` = gross wager. `data` = ABI-encoded game-specific metadata (schema below). |
| `BetSettled` | `(uint256 indexed requestId, address indexed player, uint256 payout, bytes data)` | Bet resolved with `payout >= 0`. `data` = ABI-encoded outcome details. |
| `BetFailed` | `(uint256 indexed requestId, address indexed player, bytes32 reason)` | Bet failed before resolution (VRF timeout, cancel, etc.). `reason` is a per-game tag (e.g. `"VRF_TIMEOUT"`, `"CANCELED_EXPIRED"`, `"CANCELED_NEW_GAME"`, `"EXPIRED"`). |

**Per-game `data` schemas.** Each game's `BetPlaced.data` and `BetSettled.data` are documented in [GAME_AUTHOR_GUIDE.md §10](./GAME_AUTHOR_GUIDE.md#10-per-game-event-data-schemas). The schemas are stable across game versions; if a game evolves its outcome model, the schema gets a versioned successor rather than a silent change.

---

## 3. Shape-base layer — VRF lifecycle

The three shape bases (`PushVRFGame` / `PullVRFGame` / `OperatorGame`) don't add events of their own; they inherit from BaseGame + Multicallable + GameLifecycleRoles + IGameEvents. The **shape difference** is in how VRF interacts with the lifecycle:

### Push VRF (Roulette, Slots, Plinko, ProgressiveJackpot direct bets)

The VRF coordinator calls `fulfillRandomness` directly on the game, which runs settlement inline. From an indexer's perspective:

```
BetPlaced + RandomWordsRequested        ← placement
... seconds pass ...
RandomWordsFulfilled + game-specific resolved event + BetSettled  ← settlement (all in one tx)
```

You can match a placement to its settlement via `requestId`. Settlement is **a separate transaction** from placement (the VRF callback is its own tx).

### Pull VRF (Mines)

VRF still fires `RandomWordsFulfilled` via push, but Pull-shape games implement a no-op callback — they read the VRF word later via `getRawWord(requestId)` when an action (e.g. `claim`) requires randomness. Lifecycle:

```
BetPlaced + RandomWordsRequested        ← startGame (placement)
... seconds pass ...
RandomWordsFulfilled (no-op for Mines)  ← VRF lands
... player takes additional actions: commitToClicks, claim ...
ClickCommitmentMade                     ← intermediate state
GameClaimed + BetSettled                ← claim tx reads getRawWord and resolves
```

Mines uses operator-attested off-chain signing (`_verifyOperatorAttestation` against the `gameOperators` allowlist) to validate the player's claim. The attestation isn't a separate event — it's checked inside the `claim` tx.

### Operator-driven (PaymentOnlyGameAdapter, TicketLottery)

No VRF on the placement path (or, in the case of TicketLottery, VRF is the entire game). PaymentOnlyGameAdapter just routes bets through PaymentHandler and lets the operator pay winners offline-decided. TicketLottery has its own VRF call to Chainlink coordinator directly. Lifecycle is per-game; see §4.

---

## 4. Game-specific event reference

Inventories below cover only the events declared on each game contract beyond what it inherits. For inherited events (PaymentHandlerUpdated, EmergencyWithdraw, MulticallSubCallFailed, GameOperatorSet, BetPlaced/BetSettled/BetFailed) see §2.

### `SingleRandomRoulette`

| Event | Signature |
|---|---|
| `SpinStarted` | `(uint256 indexed requestId, address indexed player, uint256 wager, uint256 netStake, uint256 multiplierHundredths, uint256 maxPayout, uint32 configIndex, bool participatingInJackpot)` |
| `SpinResolved` | `(uint256 indexed requestId, address indexed player, uint8 outcome, uint256 payout, uint8 spinsConsumed, uint256 jackpotPayout)` |
| `SpinFailed` | `(uint256 indexed requestId, address indexed player, bytes32 reason)` |
| `TableConfigUpdated` | `(uint32 index, bool enabled, uint16 replayBps, uint16 jackpotBps, uint16 minMultiplier, uint16 maxMultiplier, uint256 minWager, uint256 maxWager)` |
| `JackpotScalingUpdated` | `(uint32 index, bool enabled, uint16 minJackpotBps, uint16 maxJackpotBps, uint256 minJackpotWager, uint256 maxJackpotWager, JackpotScalingLib.ScalingFunction functionId)` |

`SpinResolved.outcome` enum: 0 = lose, 1 = multiplier, 2 = jackpot, 3 = replay. `payout` is the on-chain payout (excluding jackpot share, which is reported separately).

Roulette is **append-only versioned** on configs: every `setTableConfig` / `setJackpotScalingConfig` pushes a new entry into the underlying array. An indexer can re-query any historical config by `configIndex`.

### `MinesGameHybrid`

| Event | Signature |
|---|---|
| `GameStarted` | `(uint256 indexed requestId, address indexed player, uint256 wager, uint256 netStake, uint8 minesCount, bytes32 commit, uint256 lockedAmount)` |
| `ClickCommitmentMade` | `(uint256 indexed requestId, address indexed player, bytes32 clickCommit)` |
| `GameClaimed` | `(uint256 indexed requestId, address indexed player, uint8 minesCount, uint8 safeClicks, bool hitMine, uint32 finalMultiplierHundredths, uint16 maintenanceEdgeBps, uint256 payout)` |
| `GameCanceled` | `(uint256 indexed requestId, address indexed player, uint256 refundAmount)` |
| `TableConfigUpdated` | `(bool enabled, uint8 minMines, uint8 maxMines, uint256 minWager, uint256 maxWager, uint32 claimTimeout)` |
| `MaintenanceEdgeUpdated` | `(uint16 maintenanceEdgeBps)` |
| `MultiplierTableSet` | `(uint8 minesCount, uint32[] multipliersHundredths)` |
| `ResolveFeeBpsUpdated` | `(uint16 oldBps, uint16 newBps)` |

Mines lifecycle (multi-step): `GameStarted` → `ClickCommitmentMade` → `GameClaimed` (success) or `GameCanceled` (timeout / new-game preemption).

`GameCanceled.refundAmount` is **non-zero only on `cancelExpired(_, refundPlayer=true)`** — the implicit start-of-new-game cancel emits `refundAmount = 0`.

### `Plinko`

| Event | Signature |
|---|---|
| `BetPlaced` *(game-specific, has same name as envelope; viem disambiguates by sig)* | `(uint256 indexed requestId, address indexed player, uint256 betAmount, uint8 rows, RiskLevel risk, uint8 numDrops, uint256 totalWager, uint256 maxPayout)` |
| `BetSettled` *(game-specific)* | `(uint256 indexed requestId, address indexed player, uint256 totalPayout, uint8 numDrops, uint8[] slots, uint256 randomWord)` |
| `MultipliersUpdated` / `AllowedRowsUpdated` / `BetLimitsUpdated` / `MaxDropsUpdated` / `BetExpiryBlocksUpdated` / `MaxPendingBetsPerPlayerUpdated` / `MaxTotalPendingBetsUpdated` | various admin |

Plinko's `BetPlaced` and `BetSettled` are dual-emit-collapsed: the game-specific events have the same name as the envelope events but with different signatures. The envelope events from `IGameEvents` are still emitted as a separate logs. Two `BetPlaced` events per placement, two `BetSettled` events per settlement — different topic hashes.

`BetSettled.slots` is the array of bucket positions each drop landed in; `randomWord` is the raw VRF word for off-chain replay/verification.

### `MultiLineSlots`

| Event | Signature |
|---|---|
| `SpinStarted` | `(uint256 indexed requestId, address indexed player, uint8 activePaylines, uint256 wagerPerLine, uint256 totalWager, uint256 netStake, uint32 configIndex)` |
| `SpinResolved` | `(uint256 indexed requestId, address indexed player, uint8[GRID_SIZE] grid, uint8 winningLineCount, uint256 totalPayout)` |
| `SpinFailed` | `(uint256 indexed requestId, address indexed player, bytes32 reason, uint256 refundAmount)` |
| `SlotsConfigUpdated` / `SymbolConfigUpdated` | various admin |

`SpinResolved.grid` is the 3x3 final grid as a flat 9-element array. `SpinFailed.refundAmount` is non-zero because Slots refunds `netStake` on VRF failure (the only game that auto-refunds).

### `PaymentOnlyGameAdapter`

| Event | Signature |
|---|---|
| `GamePlayed` | `(address indexed player, uint256 amountPaid, uint256 netAmount, address potentialReferrer, bytes32 gameId)` |
| `WinnerPaid` | `(address indexed player, uint256 amount)` |

Plus envelope `BetPlaced` (no envelope `BetSettled` — payout isn't bet-linked here, the operator decides winners off-chain). `gameId` is a per-play identifier the operator passes through to link on-chain plays back to off-chain game sessions.

### `TicketLottery`

| Event | Signature |
|---|---|
| `LotteryRequested` | `(uint256 indexed requestId, uint256 totalTickets, uint8 numWinners, uint256 playerCount)` |
| `LotteryFulfilled` | `(uint256 indexed requestId, address[] winners, uint256 randomWord)` |

Two-step single-shot. TicketLottery doesn't inherit from BaseGame and doesn't emit the IGameEvents envelope.

### `CrashGame`

The most complex lifecycle on the platform.

| Event | Signature |
|---|---|
| **round lifecycle** | |
| `RoundCreated` | `(uint256 indexed roundId, bytes32 commitHash, uint64 bettingOpensAt)` |
| `RoundBettingOpened` | `(uint256 indexed roundId)` |
| `RoundRunning` | `(uint256 indexed roundId, uint256 vrfRequestId)` |
| `RoundCrashed` | `(uint256 indexed roundId, uint32 crashPoint, uint256 vrfRandomWord)` *(`crashPoint = 0` because seed not yet revealed — see `RoundRevealed`)* |
| `RoundRevealed` | `(uint256 indexed roundId, bytes32 serverSeed, uint32 crashPoint)` *(crashPoint is the deterministic final multiplier in bps)* |
| `RoundSettled` | `(uint256 indexed roundId, uint32 crashPoint, uint256 totalBetAmount, uint256 totalPayout)` *(round-final result with totals)* |
| `MerkleRootSubmitted` | `(uint256 indexed roundId, bytes32 merkleRoot)` |
| `UnclaimedExposureExpired` | `(uint256 indexed roundId, uint256 amount)` |
| **bet lifecycle** | |
| `BetPlaced` *(game-specific)* | `(uint256 indexed roundId, address indexed player, uint256 betId, uint256 amount, uint256 netAmount, BetMode mode, uint32 autoCashoutMultiplier)` |
| `PayoutClaimed` | `(uint256 indexed roundId, address indexed player, uint256 betId, uint256 payout)` |
| `BatchPayoutClaimed` | `(address indexed player, uint256 totalPayout, uint256 claimCount)` |
| `ClaimSkipped` | `(uint256 indexed betId, uint8 reason)` *(reasons: 1=BetNotFound, 2=NotBetOwner, 3=AlreadyClaimed, 4=RoundNotRevealed, 5=ExposureNotSettled, 6=MerkleRootNotSet, 7=InvalidMultiplier, 8=InvalidMerkleProof)* |
| **admin / lifecycle** | |
| `ConfigUpdated` | `(string paramName, uint256 oldValue, uint256 newValue)` *(every setter emits with old+new pairs — gold-standard pattern)* |
| `OperatorBondDeposited` / `OperatorBondWithdrawn` | `(address indexed operator, uint256 amount)` |
| `PlayerBanned` | `(address indexed player, bool banned)` |

**Round result reconstruction.** The indexer answers "what happened in round N" using `RoundSettled`:

- `crashPoint` — the final multiplier in basis points (25000 = 2.50x)
- `totalBetAmount` — sum of net bet amounts across all players
- `totalPayout` — operator-submitted sum of payouts (matches what claims will distribute)

For per-player winners: filter `BetPlaced` events by `roundId`, then for **AUTO mode**: bet wins iff `autoCashoutMultiplier < crashPoint` (compute locally; the payout = `netAmount × autoCashoutMultiplier / 10000`). For **MANUAL mode**: winners show up as `PayoutClaimed` events.

The `RoundCrashed` event's `crashPoint` field is **always 0** because at that moment the serverSeed is still hidden behind `commitHash`. The actual crash point is only emitted in `RoundRevealed`. This is a deliberate commit-reveal property — don't try to extract crashPoint from `RoundCrashed`.

---

## 5. Per-game `data` schemas (envelope events)

Decoders for the `bytes data` payload of `BetPlaced` / `BetSettled`. Each schema is stable across versions; if a game changes its outcome model the schema gets a successor and the old one is retained for replay.

```
Roulette.BetPlaced.data:    abi.decode(data, (uint256 netStake, uint256 multiplierHundredths, uint256 maxPayout, uint32 configIndex, bool participateInJackpot))
Roulette.BetSettled.data:   abi.decode(data, (uint8 outcome, uint8 spinsConsumed, uint256 jackpotPayout))

Mines.BetPlaced.data:       abi.decode(data, (uint256 netStake, uint8 minesCount, bytes32 commit, uint256 lockedAmount))
Mines.BetSettled.data:      abi.decode(data, (uint8 minesCount, uint8 safeClicks, bool hitMine, uint32 tableMultiplier, uint16 maintenanceEdgeBps, uint256 fee))

Plinko.BetPlaced.data:      abi.decode(data, (uint256 betAmount, uint8 rows, uint8 risk, uint8 numDrops, uint256 maxPayout))
Plinko.BetSettled.data:     abi.decode(data, (uint8 numDrops, uint8[] slots, uint256 randomWord))

Slots.BetPlaced.data:       abi.decode(data, (uint8 activePaylines, uint256 wagerPerLine, uint256 netStake, uint32 configIndex))
Slots.BetSettled.data:      abi.decode(data, (uint8[GRID_SIZE] grid, uint8 winningLineCount))

PaymentOnlyGameAdapter.BetPlaced.data: abi.decode(data, (uint256 netAmount, address potentialReferrer, bytes32 gameId))
PaymentOnlyGameAdapter.BetSettled:    not emitted (payouts aren't bet-linked)

ProgressiveJackpot direct bets:      no envelope; use DirectBetRequested + DirectBetSettled
Crash:                                no envelope; use BetPlaced + PayoutClaimed
TicketLottery:                        no envelope; use LotteryRequested + LotteryFulfilled
```

---

## 6. Recommended subgraph entity model

A starting-point schema. Adapt to your platform:

```
Player(id: address) {
  sessionKey: address              # from latest SessionKeyAuthorized
  spendCapCumulative: uint256      # from latest SessionKeyAuthorized
  spentToDate: uint256             # sum of SpendingRecorded.amount
  referrer: address                # from ReferrerRecorded
  bets: [Bet!]                     # reverse relation
}

Bet(id: (game, requestId)) {       # composite — requestId is per-game
  game: address
  player: Player
  amount: uint256                  # from BetPlaced.amount
  data: bytes                      # raw envelope payload — decode per game
  placedAt: timestamp
  settledAt: timestamp?
  payout: uint256?                 # from BetSettled
  outcomeData: bytes?              # BetSettled.data
  status: enum(Placed, Settled, Failed, Refunded)
  failureReason: bytes32?
  refundAmount: uint256?
}

CrashRound(id: (game, roundId)) {
  state: enum(Created, Betting, Running, Crashed, Revealed)
  commitHash: bytes32
  serverSeed: bytes32?
  vrfRandomWord: uint256?
  crashPoint: uint32?              # from RoundRevealed / RoundSettled
  totalBetAmount: uint256?         # from RoundSettled
  totalPayout: uint256?            # from RoundSettled
  bets: [Bet!]
}

JackpotEntry(id: entryId) {        # one per EntryProcessed
  game: address
  player: Player
  tierIndex: uint8
  outcomeIndex: uint8
  payout: uint256
  timestamp
}

ReferralReward(id: (player, recipient, txHash)) {
  player: Player                   # who placed the bet
  recipient: address               # who got paid
  level: uint8
  amount: uint256
  withdrawnAt: timestamp?
}
```

Index `Bet` on (player, game, status) for player history queries; on (game, status, placedAt desc) for recent-activity feeds.

---

## 7. Operational guidance

### Reorg safety

Arbitrum One has fast finality (~250ms soft confirmation) but the indexer should still wait N blocks before treating a log as final. For Arbitrum: 10–20 blocks (~10–20 seconds) is conservative; for production-grade analytics, wait for L1 finality (~10 minutes).

### Event ordering within a tx

Logs in a transaction are emitted in execution order. For a single bet you'll typically see:

1. `Approval` / `Transfer` (ERC20)
2. `AuthHub.SpendingRecorded` (if delegated)
3. `MultiLevelReferral.RewardCredited` × N (if referral)
4. `PaymentHandler.GameBetProcessed`
5. game-specific event (`SpinStarted`, etc.)
6. `IGameEvents.BetPlaced`

For multicallTry: the loop processes sub-calls in order, and each sub-call's events appear consecutively. Reverting sub-calls produce ONE event (`MulticallSubCallFailed`) at the outer level.

### Handling missing fulfillment

If a game emits `BetPlaced` but you never see `BetSettled` AND there's no `BetFailed` AND the `RandomProvider.RequestFailed` for the requestId hasn't landed: the bet is stuck (VRF subscription out of LINK, or a contract-level issue). Surface this as a player support ticket — the platform team can `forceFailRequest` to unstick it.

### Cross-chain considerations

The platform deploys per-chain; there's no cross-chain indexing. If you deploy to multiple Arbitrum-shaped chains (Sepolia + Mainnet + a future Orbit chain), use the chainId as part of every entity ID.

---

## 8. Recommendations for new games

If you're adding a new game to the platform, follow these conventions so the indexer can ingest it without special-casing:

1. **Emit the IGameEvents envelope.** `BetPlaced` on placement, `BetSettled` on resolution, `BetFailed` on cancel/timeout. This single rule is what lets cross-game queries work uniformly.
2. **`requestId` is the join key.** Use the VRF request ID for VRF games; for operator-driven games use a sequential bet ID. Whatever you use, surface it in the envelope events.
3. **Document the `data` schema in your contract's NatSpec.** Future indexer authors should be able to figure out how to decode `BetPlaced.data` without reading the contract source.
4. **Emit lifecycle events for any multi-step flow.** Mines emits `ClickCommitmentMade` for the intermediate commit step. If your game has analogous steps, emit per-step events with `requestId` indexed.
5. **Emit refund amounts on cancel/failure paths.** Slots's `SpinFailed.refundAmount` and Mines's `GameCanceled.refundAmount` set the pattern. If your game refunds anything, include the amount in the event.
6. **Don't emit per-loser events.** Losers are inferred by absence of `BetSettled.payout > 0` (or by computation against the round result for games with rollup events like Crash's `RoundSettled.crashPoint`). Emitting a `BetLost` per losing bet would cost gas on every loss for marginal indexer convenience.
7. **Use old+new pairs on admin setter events.** This is the most important indexer-friendly pattern for config audit trails. CrashGame's `ConfigUpdated(string paramName, uint256 oldValue, uint256 newValue)` is the gold standard — one event signature for every setter, paramName routes the consumer.
8. **Never make a state change silent.** Every public state mutation should have a corresponding event. The platform recently fixed three silent setters (`BaseGame.setPaymentHandler`, `ProgressiveJackpot.setPaymentHandler`, `RandomProvider.setKeyHash`); don't reintroduce the pattern.

---

## 9. Where to look next

- [ARCHITECTURE.md](./ARCHITECTURE.md) — the overall platform shape, money flow, randomness model
- [GAME_AUTHOR_GUIDE.md](./GAME_AUTHOR_GUIDE.md) — building a new game, including the per-game `data` schema section
- [DELEGATED_AUTH.md](./DELEGATED_AUTH.md) — operator backend that produces the `*For` calls feeding into these events
- [contracts/games/base/IGameEvents.sol](../contracts/games/base/IGameEvents.sol) — the envelope event interface every game inherits

When in doubt, the contracts are the source of truth. Every event signature above was inventoried directly from source — if you find a discrepancy, the contract wins.
