# Building a Game on The Burning Games

Practical guide for teams writing a new game on the platform. Assumes you've read [ARCHITECTURE.md](./ARCHITECTURE.md) for the conceptual model.

This document covers:
1. Picking a shape base
2. Writing the contract (direct + delegated entry, fulfillment, events)
3. The EIP-712 typehash convention
4. Event emission (the dual-emit pattern)
5. Deployment + registration checklist
6. Testing checklist
7. Common pitfalls
8. Per-game event `data` schemas (reference)

---

## 1. Pick a shape base

Three canonical bases. Choose by your game's state machine:

| If your game looks like… | Use | Examples |
|---|---|---|
| One bet → VRF callback resolves and pays inline | `PushVRFGame` | Roulette, Slots, Plinko |
| Multi-player rounds where the VRF callback stores state and settlement happens later (operator-driven or per-bet auto cashout) | `PushVRFGame` | CrashGame |
| One bet → VRF lands → ...further player actions (commit / reveal / claim)... → resolve later | `PullVRFGame` | Mines |
| No VRF; operator settles based on off-chain outcome | `OperatorGame` | PaymentOnlyGameAdapter |
| No EVA / no money flow at all (admin-driven utility) | Direct inheritance — no shape base | TicketLottery |

A game that uses **VRF + server-side attestation** (oracle ECDSA signature, or operator commit-reveal) still picks one of the VRF shape bases — the attestation layer is *game-specific code*, not a separate shape. See Mines (oracle ECDSA on `PullVRFGame`) and CrashGame (operator commit-reveal on `PushVRFGame`).

You'll inherit ONE shape base. The bundle gives you token + handler + exposure + pause + emergencyWithdraw + VRF wiring + JackpotClient (Push/Pull only) + AuthHub binding + operator allowlist + standardized event envelope.

```solidity
contract MyGame is PushVRFGame {
    constructor(...)
        PushVRFGame(token, handler, provider, authHub, "MyGame", "1", initialOperator)
    { /* per-game state init */ }
}
```

---

## 2. Canonical interfaces (the rule)

**Every interaction between your game and a platform contract MUST go through an interface declared under `contracts/interfaces/`.** Redeclaring these in your game folder is forbidden.

Why:
- Single source of truth — interface changes propagate to every consumer automatically
- Audit clarity — reviewers grep one path, not parallel ABI definitions per game
- Forward compatibility — if the platform extends a contract, your game sees the new functions for free; redefined interfaces silently miss them
- No hidden drift — the historical mistake was Crash redeclaring `IPaymentHandler` / `IRandomProvider` locally; we folded them back and they're gone now

The complete consumer-side list:

| Interface | Path | When you import it |
|---|---|---|
| `IPaymentHandlerMinimal` | `contracts/interfaces/core/IPaymentHandlerMinimal.sol` | Any game taking bets (almost always — inherited via shape base) |
| `IRandomProviderMinimal` | `contracts/interfaces/core/IRandomProviderMinimal.sol` | Any VRF-driven game (inherited via `VRFGameBase`) |
| `IRandomProviderPullReader` | `contracts/interfaces/core/IRandomProviderPullReader.sol` | Pull-shape games only (inherited via `PullVRFGame`) |
| `IRandomConsumer` | `contracts/interfaces/core/IRandomConsumer.sol` | Any VRF-driven game **implements** this (inherited via `VRFGameBase`) |
| `IProgressiveJackpot` | `contracts/interfaces/core/IProgressiveJackpot.sol` | Games with jackpot participation (consumed via `JackpotClient` — direct import rarely needed) |
| `IAuthHub` | `contracts/interfaces/auth/IAuthHub.sol` | Games with `*For` entries (consumed via `SignedActionAuth`) |

The shape bases wire these for you. **If you find yourself writing a new `interface IFoo` for a platform contract, stop** — either the canonical version exists, or it needs to be added to the canonical version. Open a PR against `contracts/interfaces/` rather than creating a parallel ABI in your game folder.

---

## 3. Writing the contract

### 3.1 The internal-helper template

Every entry function comes in two flavors: **direct** (player calls) and **`*For` delegated** (operator relays on behalf of player). Both share a private internal helper so the business logic runs identically. The convention:

```solidity
function placeBet(/* args */) external nonReentrant returns (uint256 requestId) {
    return _placeBetInternal(msg.sender, /* args */);
}

function placeBetFor(
    address player,
    /* args */,
    uint256 nonce,
    uint256 deadline,
    bytes calldata signature
) external onlyOperator nonReentrant returns (uint256 requestId) {
    bytes32 structHash = keccak256(abi.encode(
        PLACE_BET_TYPEHASH,
        address(this),    // ← MUST be first arg after typehash; binds the sig to THIS contract
        player,
        /* args */,
        nonce,
        deadline
    ));
    _verifyAndConsume(player, address(this), wagerAmount, structHash, deadline, nonce, signature);
    return _placeBetInternal(player, /* args */);
}

function _placeBetInternal(address bettor, /* args */) internal returns (uint256 requestId) {
    // ───────── BUSINESS LOGIC ─────────
    // Use `bettor`, NEVER msg.sender, so events/state/payouts reference the actual
    // player on both direct and delegated paths.
}
```

Why this matters: indexers and auditors can tell at a glance whether your `*For` follows the platform pattern. Deviating creates two bug-prone paths instead of one.

### 3.2 PushVRFGame fulfillment

In `_placeBetInternal`, after validating + collecting the bet:

```solidity
function _placeBetInternal(address bettor, /* args */) internal returns (uint256 requestId) {
    // ... validation ...
    uint256 netStake = _collectAndProcessBet(bettor, potentialReferrer, totalWager);
    _lockExposure(maxPayout, jackpotShare);
    requestId = randomProvider.requestRandomNumbers(ranges);

    // Persist any per-bet state keyed by requestId so fulfillRandomness can find it
    pendingBets[requestId] = PendingBet({...});

    emit MyGameSpecificBetPlaced(requestId, bettor, ...);
    emit BetPlaced(requestId, bettor, totalWager, abi.encode(/* game-specific data */));
}
```

Then implement the VRF callback:

```solidity
function fulfillRandomness(
    uint256 requestId,
    uint256 randomWord,
    uint256[] memory derivedValues
) external override onlyRandomProvider nonReentrant {
    PendingBet memory bet = pendingBets[requestId];
    require(bet.exists, "unknown");

    _unlockExposure(bet.maxPayout, 0);   // ← MUST always unlock or exposure leaks
    delete pendingBets[requestId];

    // resolve outcome from derivedValues / randomWord
    uint256 payout = _resolve(bet, derivedValues);
    if (payout > 0) _payPlayer(bet.player, payout);

    emit MyGameSpecificBetSettled(requestId, bet.player, payout, ...);
    emit BetSettled(requestId, bet.player, payout, abi.encode(/* outcome details */));
}

function handleRandomFailure(
    uint256 requestId,
    bytes32 reason,
    bytes calldata /*details*/
) external override onlyRandomProvider nonReentrant {
    PendingBet memory bet = pendingBets[requestId];
    if (!bet.exists) return;

    _unlockExposure(bet.maxPayout, 0);   // ← unlock on failure too
    delete pendingBets[requestId];

    // Refund policy is YOUR choice. Common patterns:
    //   - Refund netStake to the player automatically (Roulette, Slots).
    //   - Leave funds in the contract, let admin reimburse off-chain (Plinko, Mines).
    // The platform does NOT mandate either.

    emit MyGameSpecificFailure(requestId, bet.player, reason);
    emit BetFailed(requestId, bet.player, reason);
}
```

### 3.3 PullVRFGame fulfillment

`PullVRFGame` provides **no-op `fulfillRandomness`** and **no-op `handleRandomFailure`** — you don't implement them. You write your own settle path that reads the VRF word on demand:

```solidity
function claim(uint256 requestId, /* player-supplied data */) external nonReentrant {
    PendingGame memory g = games[requestId];
    require(g.status == GameStatus.Started, "no game");
    require(g.player == msg.sender, "unauthorized");

    uint256 vrfWord = _readRandomWord(requestId);   // ← from PullVRFGame
    require(vrfWord != 0, "VRF not ready");

    // ...resolve, unlock exposure, pay player...

    emit MyGameSpecificClaim(requestId, msg.sender, payout, ...);
    emit BetSettled(requestId, msg.sender, payout, abi.encode(...));
}
```

Mines also takes an oracle attestation in claim — see `MinesGameHybridV2.claim` for the canonical example.

### 3.4 OperatorGame entry

No VRF, no fulfillment callback. The operator settles directly:

```solidity
function play(uint256 amount, address potentialReferrer, bytes32 gameId) external nonReentrant {
    _playInternal(msg.sender, amount, potentialReferrer, gameId);
}

function _playInternal(address player, uint256 amount, ...) internal {
    uint256 netAmount = _collectAndProcessBet(player, potentialReferrer, amount);
    uint256 betId = ++nextBetId;
    emit MyGameSpecificPlay(player, amount, ...);
    emit BetPlaced(betId, player, amount, abi.encode(...));
}

function payWinner(address player, uint256 amount) external onlyGameOperator nonReentrant {
    _payPlayer(player, amount);
    // emit BetSettled only if your payouts are bet-linked (i.e. you have a clear requestId)
}
```

---

## 4. EIP-712 typehash convention

Mandatory pattern for every `*For` entry. The typehash MUST:

1. Be named for the action (`PlaceBet`, `StartSpin`, `CommitClicks`, etc.)
2. List `address game` as the **first** field
3. List `address player` as the second field
4. End with `uint256 nonce` and `uint256 deadline`

```solidity
bytes32 public constant PLACE_BET_TYPEHASH = keccak256(
    "PlaceBet(address game,address player,uint256 betAmount,uint8 rows,uint8 risk,uint8 numDrops,address potentialReferrer,uint256 nonce,uint256 deadline)"
);
```

The `address game` field is checked by `_verifyAndConsume`: if a signature signed for game A is replayed against game B, the field doesn't match `address(this)` and the call reverts. This is defense-in-depth — the EIP-712 domain ALSO binds the contract, but the explicit field makes the binding visible to wallet UIs and audits.

The EIP-712 domain is configured by the shape base:
- `name`: chosen at construction (e.g. `"Plinko"`, `"MinesGameHybridV2"`)
- `version`: `"1"` by convention
- `chainId`: dynamic
- `verifyingContract`: the game contract itself

---

## 5. Event emission (dual-emit pattern)

At every lifecycle transition (placed / settled / failed), emit **two events**:

1. Your game's **detailed event** with decoded fields. Optimized for human/dashboard reading.
2. The platform's **IGameEvents envelope** with the same lifecycle data, plus game-specific details ABI-encoded into a `bytes data` blob.

```solidity
// Detailed (game-specific)
emit BetSettled(
    requestId,
    bet.player,
    totalPayout,
    bet.numDrops,
    slots,
    randomWord
);

// Envelope (platform standard, from IGameEvents)
emit BetSettled(
    requestId,
    bet.player,
    totalPayout,
    abi.encode(bet.numDrops, slots, randomWord)
);
```

Solidity disambiguates by argument signature — the detailed `BetSettled` takes 6 typed args, the envelope takes 4 (last is `bytes`). Same event name; different topic hashes.

**Why both?** Cross-game indexers want the uniform envelope (one schema for all games). Per-game dashboards prefer the detailed event (no decoding needed). Cost is one extra LOG per bet (~1k gas).

If your game's detailed event happens to have the EXACT same signature as the envelope (case: `BetFailed(uint256 indexed requestId, address indexed player, bytes32 reason)` matches verbatim), don't redeclare — just emit once. Plinko does this for `BetFailed`.

### Naming conflicts

Solidity rejects an event redeclaration with the same name AND same parameter types. If your detailed event needs the same name as an envelope event with the same signature, you must drop the local declaration. The compiler will tell you.

---

## 6. Operator-relayed batching (`multicallTry`)

Every game that inherits a shape base inherits `Multicallable`'s `multicallTry(bytes[] calldata data)`. The operator backend uses it to bundle N player-signed `*For` actions into one transaction:

```ts
const callA = encodeFunctionData({ abi, functionName: "startSpinFor", args: [...] });
const callB = encodeFunctionData({ abi, functionName: "startSpinFor", args: [...] });
await game.write.multicallTry([[callA, callB, ...]], { gas: 30_000_000n });
```

Semantics:
- Each entry is DELEGATECALLed against the game; `msg.sender` is preserved as the operator. All sub-call ACLs (`onlyOperator`, `_verifyAndConsume`, `nonReentrant`) fire identically to a direct call.
- A reverting sub-call is **isolated**: its state changes roll back, `successes[i]` becomes false, and `MulticallSubCallFailed(index, returnData)` is emitted from the outer frame. **The batch keeps going** — one stale-nonce or expired-deadline action no longer griefs every other player in the bundle.
- The wrapper is gated by `authHub.isOperator(msg.sender)`. Non-operator callers are rejected at the gate with `NotAuthorizedMulticaller`. You don't need to do anything to opt in — the shape base implements the gate hook for you.

### When you'd override the gate

`Multicallable` defines an abstract `_multicallAuthorized(address caller) internal view returns (bool)`. The shape bases default it to `authHub.isOperator(caller)`. If your game needs a stricter policy (e.g. a dedicated multicaller key separate from AuthHub operators), override at the game level:

```solidity
function _multicallAuthorized(address caller) internal view override returns (bool) {
    return caller == multicallerKey;   // your own policy
}
```

Most games don't need this; the AuthHub-backed default is the right call.

### What `multicallTry` does NOT do

- It does not let you batch admin operations (`onlyOwner` setters still revert if the caller isn't owner).
- It does not give player-side batching. If you want players to bundle their own direct bets, expose a dedicated `batchPlaceBetSelf()` entry — don't widen `multicallTry`'s gate.
- It does not bypass `nonReentrant`. Each sub-call acquires and releases the guard independently.

### Gas estimation caveat

`viem` (and similar clients on hardhat) under-estimate gas for `multicallTry` because the inner DELEGATECALLs are opaque to the estimator. The symptom is a sub-call that should succeed reverting with empty return data — out-of-gas inside the inner frame. Always supply an explicit gas limit on the operator's tx; don't rely on auto-estimate.

---

## 7. Deployment + registration checklist

Five steps. All admin-only. Skip any and the game won't function:

1. **Deploy the game contract** with constructor args (token, handler, provider, authHub, EIP-712 name+version, initial operator, plus game-specific).
2. **Register on PaymentHandler**: `paymentHandler.registerGame(gameAddr, payoutTarget, feeRecipient, houseEdgeBps, referralBps, jackpotBps)`. Without this, all bets revert at the handler.
3. **Register as RandomProvider consumer** (Push/Pull games only): `randomProvider.setConsumerStatus(gameAddr, true, maxRanges)`. `maxRanges` is your game's range-count requirement.
4. **Register as AuthHub spend tracker** (any game with `*For` entries): `authHub.setSpendTracker(gameAddr, true)`. Without this, every `*For` call reverts at `recordSpending`.
5. **Optional**: register on ProgressiveJackpot for jackpot entries — `pj.registerGame(gameAddr, outcomes)` if your game routes jackpot wins through PJ.

Additionally, for Push/Pull games using the platform's VRF subscription:
6. **Add the RandomProvider as a Chainlink VRF consumer** on the subscription (only needed once per RandomProvider deployment, not per game).

Then **bankroll** the game with EVA — every game needs working capital. The amount depends on max exposure across concurrent bets.

See `scripts/testnet/deploy.ts` for a worked example of all six steps.

---

## 8. Testing checklist

A new game must have tests covering:

### Construction
- Inherited state wired correctly (`paymentHandler`, `evaToken`, `randomProvider`, `authHub`)
- Initial operator seeded if provided

### Direct entry (`placeBet` style)
- Happy path: bet placed, exposure locked, VRF requested, events emitted
- All validation reverts (bad inputs, paused, blacklisted, etc.)
- Pause blocks bet inflow

### Delegated entry (`placeBetFor` style)
- Happy path: signature verified, spend cap charged, nonce incremented, same events as direct
- Rejects non-operator caller
- Rejects wrong game in payload (cross-contract replay)
- Rejects same nonce twice (replay protection)
- Rejects expired deadline
- Rejects when player has no session key authorized

### Fulfillment
- Happy path: bet settled, exposure unlocked, payout transferred, events emitted
- Rejects non-RandomProvider caller
- Failure callback handles unknown requestId gracefully
- Failure callback unlocks exposure

### Lifecycle ops
- Operator-gated functions reject non-operator callers
- Owner-gated functions reject non-owner callers
- `emergencyWithdraw` only when paused, always zeros `lockedExposure`

### Batched delegated execution (`multicallTry`)
- Operator caller with a happy-path batch: every sub-call lands, no `MulticallSubCallFailed` events, expected events fire per sub-call
- Operator caller with one bad sub-call mixed in (stale nonce or expired deadline): bad sub-call reverts in isolation, other sub-calls land, `MulticallSubCallFailed(index, returnData)` emitted for the bad index
- Non-operator caller: top-level `multicallTry` reverts with `NotAuthorizedMulticaller(caller)` (no per-sub-call execution, no event emissions, no state changes)

### Coverage targets
- Lines: ≥ 99%
- Statements: ≥ 90%

See `test/games/*.test.ts` and `test/games/*.full.test.ts` for canonical test structures.

---

## 9. Common pitfalls

- **Forgetting to use `bettor` in `_placeBetInternal`**. If you use `msg.sender` inside, your `*For` path will reference the operator, not the player. Events lie, state corrupts, payouts go to the wrong address.

- **Putting `address game` somewhere other than first in the typehash**. The field still binds the signature, but it's harder to read and audit. The convention exists so reviewers can spot deviations.

- **Skipping `_unlockExposure` in `handleRandomFailure`**. If VRF fails and you don't unlock, exposure leaks. Eventually `availableLiquidity()` returns 0 even with a full bankroll.

- **Overriding `emergencyWithdraw`**. You can't — it's non-virtual on BaseGame. If you try, the compiler will reject.

- **Adding your own `lockedExposure` variable**. CrashGame originally did this and shadowed the inherited one. The platform invariant requires writing to the inherited variable.

- **Implementing `IRandomConsumer` callbacks on a `PullVRFGame`**. They're already no-ops in the base and are non-overridable. You read VRF via `_readRandomWord(requestId)` at your own settle time.

- **Forgetting to register on PaymentHandler / AuthHub / RandomProvider**. Bets revert; `*For` reverts; VRF callbacks revert. The five-step checklist above catches this.

- **Charging more than the bet on `_verifyAndConsume`**. The third arg (`betAmount`) is what's debited against the player's AuthHub spend cap. Pass the actual wager, not netStake or maxPayout.

- **Emitting only the detailed event and forgetting the envelope** (or vice versa). The dual-emit is the convention. Tests should assert both fire.

- **Letting `_verifyAndConsume` charge 0 for non-monetary actions** (Mines `commitToClicksFor`, `claimFor`). This is the correct pattern for actions that don't consume spend cap — pass `betAmount = 0`. The nonce still increments; the signature is still verified.

- **Redefining platform interfaces in your game folder**. The canonical versions live under `contracts/interfaces/`. If you write a local `IPaymentHandler` or `IRandomProvider`, you're creating ABI drift the rest of the platform can't see. If the canonical interface is missing a function you need, extend the canonical interface in a PR — don't fork it. Crash made this mistake historically; we consolidated and the lesson is in the canonical-interfaces section above.

- **Forgetting the `multicallTry` gas hint on the operator backend**. Auto-estimation under-prices the inner DELEGATECALLs. Symptom: a sub-call that should succeed reverts with empty return data — out-of-gas. Always pass an explicit gas limit on the operator's tx.

---

## 10. Per-game event `data` schemas

For indexers consuming the standardized envelope. Each `bytes data` payload is ABI-encoded; decode using the per-game schema below.

### Plinko

```
BetPlaced.data:   abi.decode(data, (uint256 betAmount, uint8 rows, uint8 risk, uint8 numDrops, uint256 maxPayout))
BetSettled.data:  abi.decode(data, (uint8 numDrops, uint8[] slots, uint256 randomWord))
BetFailed.reason: bytes32 — typically "TIMEOUT" / "EXPIRED" / Chainlink failure tag
```

### MinesGameHybridV2

```
BetPlaced.data:   abi.decode(data, (uint256 netStake, uint8 minesCount, bytes32 commit, uint256 lockedAmount))
BetSettled.data (claim path):
                  abi.decode(data, (uint8 minesCount, uint8 safeClicks, bool hitMine, uint32 tableMultiplier, uint16 maintenanceEdgeBps))
BetSettled.data (resolveAbandoned path):
                  abi.decode(data, (uint8 minesCount, uint8 safeClicks, bool hitMine, uint32 tableMultiplier, uint16 maintenanceEdgeBps, uint256 fee))
BetFailed.reason: "CANCELED_EXPIRED" | "CANCELED_NEW_GAME"
```

### SingleRandomRoulette

```
BetPlaced.data:   abi.decode(data, (uint256 netStake, uint256 multiplierHundredths, uint256 maxPayout, uint32 configIndex, bool participateInJackpot))
BetSettled.data:  abi.decode(data, (uint8 outcome, uint8 spinsConsumed, uint256 jackpotPayout))
                  // outcome: 0=Lose, 1=Multiplier, 2=Jackpot
                  // payout (envelope field): on-chain payout + jackpotPayout
BetFailed.reason: Chainlink failure tag
```

### MultiLineSlots

```
BetPlaced.data:   abi.decode(data, (uint256 wagerPerLine, uint8 paylineCount, uint256 netStake, uint256 maxPayout, uint32 configIndex))
BetSettled.data:  abi.decode(data, (uint8[9] grid, uint8 winningLineCount))
BetFailed.reason: Chainlink failure tag
```

### PaymentOnlyGameAdapter

```
BetPlaced.data:   abi.decode(data, (uint256 netAmount, address potentialReferrer, bytes32 gameId))
BetSettled:       NOT EMITTED — payouts (payWinner) aren't bet-linked on-chain.
                  Off-chain indexers must match payWinner events to plays by player/gameId/timestamp.
```

### Games NOT using the envelope

- **TicketLottery** — doesn't inherit `IGameEvents`. Use the contract's own `LotteryRequested` / `LotteryFulfilled` events.
- **CrashGame** — bespoke hybrid shape; uses its own event surface. Schema documented in CrashGame's NatSpec.

---

## 11. Where to look next

- `contracts/games/Plinko.sol` — canonical PushVRFGame example.
- `contracts/games/MinesGameHybrid.sol` — canonical PullVRFGame example.
- `contracts/games/PaymentOnlyGameAdapter.sol` — canonical OperatorGame example.
- `scripts/testnet/deploy.ts` — end-to-end deploy + registration recipe.
- `test/games/Plinko.test.ts` + `test/games/Plinko.full.test.ts` — canonical test structure.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — conceptual model + contract reference.
