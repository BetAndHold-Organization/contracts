# Delegated Authorization — Operator Backend Guide

**Audience.** Backend authors building the service that holds the operator key(s) and relays player-signed `*For` actions on-chain. This document covers the trust model, EIP-712 payload shape, signature flow, error semantics, and operational guidance specific to that service.

For the architectural overview see [ARCHITECTURE.md §5 Actors & trust model](./ARCHITECTURE.md) and [GAME_AUTHOR_GUIDE.md §3 Writing the contract](./GAME_AUTHOR_GUIDE.md). This doc assumes you've read those and focuses on the operator side.

---

## 1. Mental model in one paragraph

Players don't directly call games. They sign typed-data (EIP-712) authorizing a specific action on a specific game, then a **trusted operator wallet** submits the transaction with the player's signature attached. The contract verifies (a) the operator is on the AuthHub allowlist, (b) the signature recovers to the player's authorized session key, (c) the action hasn't been relayed before (per-game nonce), (d) the deadline hasn't passed, (e) the action wouldn't exceed the player's spend cap. If everything checks out, the action executes as if the player had called it directly — events, nonces, and balances all reference the player, not the operator.

This is the same shape Biconomy / OpenGSN / EIP-2771 use, but on-chain-only (no relay registry, no trust hierarchies). The operator is just a wallet that holds gas and AuthHub allowlist membership.

---

## 2. Two distinct operator roles

The codebase uses "operator" for two different things. Both are managed independently; both typically resolve to the same backend address(es), but they grant different permissions and you can rotate them separately.

| Concept | Allowlist | Managed by | Purpose |
|---|---|---|---|
| **AuthHub operator** | `AuthHub.isOperator(addr)` | Platform multisig via `AuthHub.setOperator` | Can relay `*For` calls on any game (`SignedActionAuth.onlyOperator` checks this) |
| **Game operator** (a.k.a. `gameOperators`) | `GameLifecycleRoles.gameOperators[addr]` per game | Each game's owner via `setGameOperator` / `setGameOperators` | Can call game-specific lifecycle ops (`createRound`, `revealSeed`, `resolveAbandoned`, etc.) AND the game accepts ECDSA attestations from this address (used by Mines for click-outcome signatures) |

In practice the backend tends to hold **one wallet per environment** (testnet, mainnet) registered in both lists. Splitting the two roles to different wallets is supported and recommended for higher-risk games: rotating one doesn't affect the other.

The `multicallTry` batching primitive is gated to AuthHub operators only — see §7.

---

## 3. Session-key model

Every player authorizes one **session key** on `AuthHub` before any delegated action can be relayed for them:

```solidity
AuthHub.authorize(
    address sessionKey,       // the public address whose private key will sign actions
    uint64 expiresAt,         // 0 = never expires (subject to the admin cap)
    uint128 spendCap          // total EVA the session key may spend across all games; 0 = unlimited
);
```

The session key is the *public address* the backend will use to sign on the player's behalf, AND the *private key* the player has delegated to that backend (or wherever it's stored). Concrete options:

- **Custodial mode (typical).** The backend generates a fresh keypair per player, stores the private key encrypted at rest, signs all player actions itself. The player only authorizes once (on signup) and never sees the session key again.
- **Player-held mode.** The frontend generates a key in the player's wallet (e.g. browser passkey, WalletConnect session), and the player signs each action locally before sending it to the operator backend.

The contracts don't care which mode you use — they just verify the signature recovers to whatever address the player authorized.

**Spend cap.** The cap is per session key, cumulative across all games. Every `*For` call's `betAmount` accumulates into `AuthHub.spent[player]`; when it exceeds the cap the next call reverts with `SpendCapExceeded`. The cap can be replaced by re-authorizing the same key — that resets the spent counter.

**Expiration.** Admins set a platform-wide `maxExpirationDelta` (e.g. 30 days). Any `expiresAt` past that ceiling is clamped to `block.timestamp + maxExpirationDelta` on authorize. A backend rotating keys should re-authorize before the old one expires (gas-free re-authorize via `AuthHub.authorizeFor` is supported — player signs the new authorization off-chain, operator submits it).

**Revocation.** `AuthHub.revoke()` is callable by the player at any time. After revocation the session key can no longer sign for that player.

---

## 4. EIP-712 payload shape

Every game's `*For` entry verifies a typed-data signature with this structure:

```
Domain {
    name:              "<game name>" (e.g. "SingleRandomRoulette")
    version:           "1"
    chainId:           current chain
    verifyingContract: address(game)
}

Message {
    address game;                  // MUST equal verifyingContract — cross-game replay defense
    address player;                // the bettor
    /* game-specific fields */
    uint256 nonce;                 // must equal game.actionNonces(player)
    uint256 deadline;              // unix timestamp; tx must mine before this
}
```

The four invariants every game enforces:

| Check | Reverts with |
|---|---|
| `msg.sender` is an AuthHub operator | `NotOperator()` |
| `message.game == address(this)` | `WrongGame(expected, provided)` |
| `block.timestamp <= deadline` | `ExpiredDeadline()` |
| `message.nonce == actionNonces[player]` | `InvalidNonce()` |
| recovered signer == `AuthHub.sessionKeyOf(player)` (and non-zero) | `InvalidSignature()` / `NoSessionKey()` |
| AuthHub spend cap not exceeded | `SpendCapExceeded(attempted, cap)` |

If all pass, the per-player action nonce is incremented and the spend cap is debited atomically before the game logic runs.

### Where to find each game's typehash

Each game declares a `bytes32 public constant <ACTION>_TYPEHASH = keccak256("…")` near the top of the contract. The string passed to keccak256 is the EIP-712 type string. For example, on Roulette:

```solidity
bytes32 public constant START_SPIN_TYPEHASH = keccak256(
    "StartSpin(address game,address player,uint256 wager,uint256 multiplierHundredths,address potentialReferrer,bool participateInJackpot,uint256 nonce,uint256 deadline)"
);
```

The backend builds the payload by ABI-encoding `(TYPEHASH, address(game), player, wager, …, nonce, deadline)`, hashing, EIP-712-wrapping with `_hashTypedDataV4`, and signing with the session key. The exact field order in the typehash string is the order the contract uses in `abi.encode` — match it exactly or the signature won't recover.

The reference implementation lives in `scripts/testnet/play-delegated.ts` — every game's signing helper is implemented there with viem's `signTypedData`. The backend implementation should produce identical bytes.

---

## 5. Per-game `*For` quick reference

Every shipped game has one or more `*For` entries. Each follows the same shape: typed-data signature with `address game` first, `nonce + deadline` last, game-specific fields in between.

| Game | Function | Game-specific fields |
|---|---|---|
| Roulette | `startSpinFor` | `wager, multiplierHundredths, potentialReferrer, participateInJackpot` |
| Slots | `startSpinFor` | `wager, paylines, symbolMask, potentialReferrer` |
| Plinko | `placeBetFor` | `rows, risk, numDrops, betAmount, potentialReferrer` |
| Mines | `startGameFor` | `wager, minesCount, potentialReferrer, commit` |
| Mines | `commitToClicksFor` | `requestId, clickCommit` *(spend cap NOT charged — pass `0` as `betAmount`)* |
| Mines | `claimFor` | `requestId, secret, clicksHash, nonceCommit` *(spend cap NOT charged)* |
| ProgressiveJackpot | `placeDirectBetFor` | `potentialReferrer` *(cost is read from current tier config)* |
| Crash | `placeBetFor` | `amount, autoCashoutMultiplier, referrer` |
| PaymentOnlyGameAdapter | `playFor` | `amount, potentialReferrer, gameId` |

Functions that don't move money but still consume a nonce (Mines `commitToClicksFor` / `claimFor`) pass `betAmount = 0` to `_verifyAndConsume`; the spend cap is not debited but the nonce still increments and the signature is still verified.

---

## 6. The recommended request flow

1. **Frontend** collects action parameters from the player. Computes the EIP-712 payload (game-specific fields + nonce + deadline) and sends to the backend.
2. **Backend** validates:
   - `player` exists in your user DB
   - `player`'s `AuthHub.sessionKeyOf(player)` matches the session key you control
   - `actionNonces[player]` matches the nonce in the payload (read from chain or your local cache)
   - The deadline is reasonable (e.g. within the next ~60 seconds)
   - The action passes any backend-side rules (anti-fraud, rate limits, balance gating)
3. **Backend** signs the EIP-712 hash with the session-key private key.
4. **Backend** submits the `*For` transaction from the operator wallet, with the signature in the last argument.
5. **Backend** records the tx hash. If the tx reverts, surface the revert reason to the user; if it succeeds, watch for the per-game settlement event (`SpinSettled`, `BetSettled`, etc.) and update local state.

Typical end-to-end latency: ~200ms for the signature + 1-3 seconds for the tx to land + 30-90 seconds for VRF callback (on VRF-driven games).

---

## 7. Batching: `multicallTry`

Every game that inherits a shape base (and ProgressiveJackpot directly) exposes:

```solidity
function multicallTry(bytes[] calldata data)
    external
    returns (bool[] memory successes, bytes[] memory results);
```

DELEGATECALLs each entry against the game, preserving `msg.sender` as the operator. **A reverting sub-call is isolated** — its state changes roll back, `MulticallSubCallFailed(index, returnData)` is emitted from the outer frame, and iteration continues. One bad action (stale nonce, expired deadline, malformed sig) no longer aborts every other player's bet in the batch.

**Authorization.** Gated to AuthHub operators (the wrapper checks `authHub.isOperator(msg.sender)` via the shape-base hook). A non-operator caller is rejected with `NotAuthorizedMulticaller(caller)` before any sub-call runs.

**Use cases.**
- Bundle multiple players' independent `*For` actions into one tx per tick (gas-efficient, atomic operator-EOA nonce).
- Bundle related actions for one player (e.g. Mines `commitToClicksFor` + claim-prep in one tick).

**Gotcha.** Some clients (notably viem on hardhat) under-estimate gas for `multicallTry` because the inner DELEGATECALLs are opaque to the gas estimator. Always pass an explicit `gas` limit on the outer tx — call `eth_estimateGas` with a generous buffer and forward as `tx.gas`. The symptom of getting this wrong is a sub-call reverting with empty return data (`0x`) — out-of-gas inside the inner frame.

See [contracts/games/base/Multicallable.sol](../contracts/games/base/Multicallable.sol) and the load test at [test/integration/MulticallTry.load.test.ts](../test/integration/MulticallTry.load.test.ts) for the canonical pattern.

---

## 8. Operational guidance

### Operator key rotation

The platform supports two independent allowlists per game (AuthHub-operator and game-operator). To rotate the operator backend key safely:

1. Add the new operator address to AuthHub: `authHub.setOperator(newOp, true)`
2. Add it as a `gameOperator` on every game: `game.setGameOperator(newOp, true)` (per game)
3. Verify the new operator can sign and submit txs on testnet
4. Disable the old operator: `authHub.setOperator(oldOp, false)`, `game.setGameOperator(oldOp, false)` everywhere

Both old and new can coexist indefinitely. There's no atomic swap — the platform expects gradual migration.

### Nonce management

Per-player, per-game action nonces live in storage on each game contract. Read with `game.actionNonces(player)` or the convenience `game.getActionNonce(player)`. The backend should cache the next-expected nonce per (player, game) and only refresh on revert.

**Race conditions.** If two backend instances both believe they hold the next-nonce for a player on a game, the second to land reverts with `InvalidNonce()`. The contract's per-sub-call revert under `multicallTry` handles this gracefully — the bad sub-call is isolated and the rest of the batch proceeds. Without `multicallTry`, the second tx just reverts and the operator must re-fetch + retry.

### Replay protection

Three independent guards prevent replay:

1. **Per-game action nonce** — the nonce is checked against on-chain storage at the start of `_verifyAndConsume` and incremented before any state-modifying work. A signature is single-use within a game.
2. **Game binding via `address game` field** — the signature is bound to a specific game contract address. The same player's signature for Roulette cannot be replayed on Mines (or on a future Roulette redeploy at a different address).
3. **Deadline** — every signature carries an expiration. Stale signatures revert with `ExpiredDeadline()`. The backend should pick a short deadline (e.g. 60s); long deadlines aren't a security risk but waste gas on inevitable retries.

### Spend-cap exhaustion

When a player's session key hits its `spendCap`, every subsequent bet reverts with `SpendCapExceeded`. UX recommendations:

- Show remaining spend cap (`AuthHub.remainingSpend(player)`) in the frontend so players see when re-auth is needed.
- Treat `SpendCapExceeded` as a soft error — surface a "re-authorize session key" CTA, not a generic failure.
- Re-authorization is via the same `AuthHub.authorize` (player-driven) or `AuthHub.authorizeFor` (operator-relayed with a fresh EIP-712 signature).

### Failure handling

Common revert categories you'll see at the operator service:

| Revert | When | What to do |
|---|---|---|
| `NotOperator()` | Your operator wallet isn't on the AuthHub allowlist | Add via `authHub.setOperator`. Configuration error, not user error. |
| `WrongGame(expected, provided)` | Signature's `game` field doesn't match the game you're calling | Signing bug. Re-check the EIP-712 domain construction. |
| `ExpiredDeadline()` | Tx mined after the signature deadline | Re-sign with a fresh deadline. |
| `InvalidNonce()` | The player has already used this nonce | Re-fetch `actionNonces(player)` and re-sign. |
| `NoSessionKey()` | Player hasn't authorized a session key yet, or it expired | Trigger the authorize flow. |
| `InvalidSignature()` | Sig recovers to wrong address (or invalid format) | Signing bug or wrong session key in the backend. |
| `SpendCapExceeded(attempted, cap)` | Player's session-key spend cap is exhausted | Surface re-authorize CTA. |
| Game-specific (e.g. `RandomNotReady`, `BettingClosed`) | The player-signed action is malformed for current game state | Game-level validation; surface to the user. |

### Gas budgeting

| Path | Approx gas |
|---|---|
| Single `*For` call (Roulette/Slots/Plinko) | 220k–320k |
| Single `placeBetFor` on Crash | 250k |
| Single Mines `startGameFor` | 380k |
| `multicallTry` with N sub-calls | ~21k (base) + N × (single-call cost) |
| Mines `commitToClicksFor` / `claimFor` | 100k / 250k |

Mainnet at 0.1 gwei: a 300k-gas tx costs ~0.00003 ETH. Bulk multicallTry batches with N=10 are ~3M gas total — comfortably under the Arbitrum block gas limit.

### Monitoring

The operator service should at minimum monitor:

- Operator wallet ETH balance (gas runway)
- AuthHub `isOperator(operatorWallet)` (should always be true)
- Per-game `gameOperators[operatorWallet]` (for games requiring it: Crash, Mines)
- Pending VRF requests count (a large queue indicates VRF subscription is out of LINK)
- `MulticallSubCallFailed` event rate (sub-call failure rate per batch)
- Revert rate per `*For` function (signals signing bugs)

---

## 9. Worked examples

The complete signing + submission flow for every game is implemented in [scripts/testnet/play-delegated.ts](../scripts/testnet/play-delegated.ts). Read that file as a reference; the production backend should produce byte-identical signatures and follow the same call shape.

Key helpers in [scripts/testnet/play-lib.ts](../scripts/testnet/play-lib.ts):

- `loadTestnetContext` — boots viem clients and reads the deployment JSON
- Per-game signing helpers (`signStartSpin`, `signStartGame`, `signPlaceBet`, etc.) — each builds the EIP-712 domain and message correctly for its game

For batched flows, see [test/integration/MulticallTry.load.test.ts](../test/integration/MulticallTry.load.test.ts) — runs 4,000 sub-calls across 4 games in 400 batched txs and verifies every emitted event payload.

---

## 10. Open items / things the backend will need to decide

These are intentionally NOT solved in the contracts. They're product decisions for the backend service:

- **Session-key storage.** Custodial (backend holds keys) vs player-held (browser passkey, mobile wallet). The contracts don't care; pick based on your UX and security posture.
- **Per-player rate limiting.** The contracts only enforce per-player nonces (one action in flight at a time) and spend caps. Higher-level rate limits (e.g. "max 10 bets/minute") belong in the backend.
- **Action-quality validation.** The contracts validate cryptographic and accounting correctness. Anti-fraud, anti-bot, "is this player allowed to bet this much," and self-exclusion — all backend.
- **Fee absorption.** The operator pays gas. You decide whether to charge users back via off-chain accounting or absorb gas as a service cost.
- **Operator key custody.** Hot wallet for low-value testnet; HSM / threshold-sig for mainnet. The contracts treat the operator as a single address regardless.
- **VRF subscription funding.** Each request burns LINK. The platform's subscription dashboard at vrf.chain.link needs to be topped up; alerting on low balance is the operator's responsibility.
