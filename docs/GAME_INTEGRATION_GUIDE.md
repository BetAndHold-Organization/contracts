# Game Integration Guide — V5 Architecture

This guide explains how to build and connect a new game to The Burning Games ecosystem using the V5 base contract architecture. It covers three integration tiers — from simple off-chain games to full on-chain games with VRF randomness and progressive jackpot participation.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Base Contract Reference](#2-base-contract-reference)
3. [Tier 1 — Off-Chain Game (BaseGame)](#3-tier-1--off-chain-game-basegame)
4. [Tier 2 — On-Chain Game with VRF (VRFGameBase)](#4-tier-2--on-chain-game-with-vrf-vrfgamebase)
5. [Tier 3 — On-Chain Game with VRF + Jackpot](#5-tier-3--on-chain-game-with-vrf--jackpot)
6. [Admin Registration Checklist](#6-admin-registration-checklist)
7. [Frontend Integration](#7-frontend-integration)
8. [Migration from V4](#8-migration-from-v4)
9. [Common Pitfalls / FAQ](#9-common-pitfalls--faq)

---

## 1. Architecture Overview

### Payment Flow

The V5 architecture introduces a security-first payment flow. Players approve **individual game contracts** — never the PaymentHandler directly. This prevents a compromised game from draining a shared approval.

```
                          ┌──────────────┐
   1. approve(game) ─────>│  ERC20 Token │
                          └──────┬───────┘
                                 │
   2. play()                     │ 3. transferFrom(player → game)
       │                         │
       v                         v
  ┌─────────┐   4. processDirectBetFromGame()   ┌──────────────────┐
  │  Player  │ ──────────────────────────────>   │  Game Contract   │
  └─────────┘                                    └──────┬───────────┘
                                                        │
                                        ┌───────────────┼───────────────┐
                                        │               │               │
                                        v               v               v
                                ┌──────────────┐ ┌───────────┐ ┌───────────────┐
                                │PaymentHandler│ │  Jackpot   │ │ Player (wins) │
                                └──────┬───────┘ └───────────┘ └───────────────┘
                                       │
                              ┌────────┼────────┐
                              v        v        v
                        House Fee  Referral  Net Stake
                        (wallet)  (contract) (→ game)
```

**Step-by-step:**

1. Player calls `token.approve(gameAddress, amount)` once.
2. Player calls the game's play/bet function.
3. The game pulls tokens from the player via `transferFrom`.
4. The game calls `PaymentHandler.processDirectBetFromGame()`, which pulls tokens from the game, deducts fees, and returns the net stake to the game's `payoutTarget`.
5. The game optionally sends a jackpot contribution.
6. On win, the game pays the player from its own balance.

### Inheritance Hierarchy

```
                  ┌────────────────────────┐
                  │  Ownable2Step          │
                  │  ReentrancyGuard       │
                  └───────────┬────────────┘
                              │
                  ┌───────────▼────────────┐
                  │      BaseGame          │  ◄── Tier 1
                  │  (token, handler,      │
                  │   exposure, payments)  │
                  └───────────┬────────────┘
                              │
                  ┌───────────▼────────────┐
                  │     VRFGameBase        │  ◄── Tier 2
                  │  (randomProvider,      │
                  │   IRandomConsumer)     │
                  └───────────┬────────────┘
                              │
                              │    ┌──────────────────────┐
                              │    │   JackpotClient      │  (mixin)
                              │    │  (deposit, enter,    │
                              │    │   ensurePayable)     │
                              │    └──────────┬───────────┘
                              │               │
                  ┌───────────▼───────────────▼┐
                  │  Concrete Game             │  ◄── Tier 3
                  │  (e.g. Roulette, Slots)    │
                  └────────────────────────────┘
```

Choose your tier based on what your game needs:

| Need | Tier 1 | Tier 2 | Tier 3 |
|---|:---:|:---:|:---:|
| Bet collection & fee processing | Yes | Yes | Yes |
| Exposure locking | Optional | Yes | Yes |
| On-chain VRF randomness | No | Yes | Yes |
| Jackpot contribution | No | No | Yes |
| Jackpot entry (player can win) | No | No | Yes |

---

## 2. Base Contract Reference

### BaseGame (`contracts/base/BaseGame.sol`)

Provides token management, payment handler integration, exposure locking, and emergency withdrawal.

| Function | Visibility | Purpose |
|---|---|---|
| `_collectBet(player, amount)` | internal | Pull tokens from the player into the game. Player must have approved this game contract. |
| `_processBet(bettor, referrer, amount)` | internal | Forward a bet through the PaymentHandler (fees, referrals). Returns `netStake`. |
| `_collectAndProcessBet(player, referrer, amount)` | internal | Convenience: `_collectBet` + `_processBet` in one call. Returns `netStake`. |
| `_payPlayer(player, amount)` | internal | Transfer tokens from game to player (winnings/refunds). |
| `_lockExposure(maxPayout, jackpotContribution)` | internal | Reserve liquidity for a pending bet. Reverts with `LiquidityShortfall` if insufficient. |
| `_unlockExposure(maxPayout, jackpotContribution)` | internal | Release reserved liquidity when a bet resolves. |
| `availableLiquidity()` | external view | Token balance minus locked exposure. |
| `setPaymentHandler(newHandler)` | external onlyOwner | Swap handler; manages ERC20 approvals automatically. |
| `emergencyWithdraw(to, amount)` | external onlyOwner | Emergency token extraction. Override to reset internal accounting if needed. |

**State variables:**
- `evaToken` (IERC20, immutable) — the ecosystem ERC20 token.
- `paymentHandler` (IPaymentHandlerMinimal) — the payment handler contract.
- `lockedExposure` (uint256) — total tokens reserved for pending bets.

### VRFGameBase (`contracts/base/VRFGameBase.sol`)

Extends BaseGame with Chainlink VRF plumbing.

| Function / Modifier | Purpose |
|---|---|
| `randomProvider` (immutable) | The `RandomProviderV2` instance. |
| `onlyRandomProvider` modifier | Restricts callback functions to the VRF provider. |

**You must implement** (from `IRandomConsumer`):

```solidity
function fulfillRandomness(
    uint256 requestId,
    uint256 randomWord,
    uint256[] memory derivedValues
) external override onlyRandomProvider;

function handleRandomFailure(
    uint256 requestId,
    bytes32 reason,
    bytes calldata details
) external override onlyRandomProvider;
```

### JackpotClient (`contracts/base/JackpotClient.sol`)

Mixin for games that interact with the Progressive Jackpot. Does **not** inherit BaseGame — it composes alongside it via multiple inheritance.

| Function | Visibility | Purpose |
|---|---|---|
| `_jackpotToken()` | internal view virtual | **Must override.** Return the game's ERC20 token (typically `evaToken`). |
| `_setJackpot(newJackpot)` | internal | Set/clear jackpot address. Manages ERC20 approvals automatically. |
| `_depositToJackpot(amount)` | internal | Send contribution to jackpot. No-op if jackpot is not set or amount is zero. |
| `_enterJackpot(player, betAmount, roll)` | internal | Enter the player into the jackpot draw. Returns payout (may be zero). |
| `_ensureJackpotPayable(betAmount)` | internal view | Revert if the jackpot cannot pay out for the given bet. |

**State variables:**
- `jackpot` (IProgressiveJackpotV2) — the jackpot contract.
- `jackpotRollCap` (uint256) — probability precision from the jackpot (e.g. 10000).

---

## 3. Tier 1 — Off-Chain Game (BaseGame)

Use this tier for games where logic and winner determination happen off-chain (server-side). The contract handles bet collection, fee routing, and owner-triggered payouts.

### Complete Example

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {BaseGame} from "./base/BaseGame.sol";

contract MyOffChainGame is BaseGame {
    event BetPlaced(
        address indexed player,
        uint256 amount,
        uint256 netAmount,
        bytes32 gameId
    );
    event WinnerPaid(address indexed player, uint256 amount);

    constructor(address token, address handler)
        BaseGame(token, handler)
    {}

    /// @notice Player places a bet. Game logic resolved off-chain.
    function placeBet(
        uint256 amount,
        address referrer,
        bytes32 gameId
    ) external nonReentrant {
        require(amount > 0, "amount=0");
        uint256 netAmount = _collectAndProcessBet(msg.sender, referrer, amount);
        emit BetPlaced(msg.sender, amount, netAmount, gameId);
    }

    /// @notice Owner pays the winner after off-chain resolution.
    function payWinner(address player, uint256 amount) external onlyOwner nonReentrant {
        require(player != address(0) && amount > 0, "bad args");
        _payPlayer(player, amount);
        emit WinnerPaid(player, amount);
    }
}
```

### What happens under the hood

1. `_collectAndProcessBet(msg.sender, referrer, amount)`:
   - Calls `evaToken.safeTransferFrom(player, address(this), amount)` — pulls tokens from player.
   - Calls `paymentHandler.processDirectBetFromGame(player, referrer, amount)` — handler pulls tokens from game, deducts house edge and referral fee, returns net stake to the game's `payoutTarget`.
2. `_payPlayer(player, amount)`:
   - Calls `evaToken.safeTransfer(player, amount)` — sends winnings from game balance.

### Constructor arguments

| Param | Description |
|---|---|
| `token` | Address of the ERC20 token (EverValueCoin / TRT) |
| `handler` | Address of the deployed PaymentHandler |

---

## 4. Tier 2 — On-Chain Game with VRF (VRFGameBase)

Use this tier for games that need verifiable on-chain randomness but do not interact with the jackpot. The game requests random numbers from `RandomProviderV2` and receives a callback.

### Complete Example: Coin Flip

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {VRFGameBase} from "./base/VRFGameBase.sol";
import {RandomDeriveLib} from "./libraries/RandomDeriveLib.sol";

contract CoinFlip is VRFGameBase {
    struct PendingFlip {
        address player;
        uint256 wager;
        uint256 netStake;
        uint256 maxPayout;
        bool headsGuess; // true = heads, false = tails
        bool exists;
    }

    mapping(uint256 => PendingFlip) public pendingFlips;

    event FlipStarted(uint256 indexed requestId, address indexed player, uint256 wager, bool headsGuess);
    event FlipResolved(uint256 indexed requestId, address indexed player, bool won, uint256 payout);
    event FlipFailed(uint256 indexed requestId, address indexed player);

    uint256 public minWager;
    uint256 public maxWager;

    constructor(address token, address handler, address provider)
        VRFGameBase(token, handler, provider)
    {}

    function setWagerLimits(uint256 min, uint256 max) external onlyOwner {
        minWager = min;
        maxWager = max;
    }

    function flip(
        uint256 wager,
        bool headsGuess,
        address referrer
    ) external nonReentrant returns (uint256 requestId) {
        require(wager >= minWager && wager <= maxWager, "wager out of range");

        // 1. Collect bet and process fees
        uint256 netStake = _collectAndProcessBet(msg.sender, referrer, wager);

        // 2. Calculate max payout (2x the wager for a coin flip)
        uint256 maxPayout = wager * 2;

        // 3. Lock liquidity for this pending bet
        _lockExposure(maxPayout, 0);

        // 4. Request one random number in range [0, 2)
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = RandomDeriveLib.Range({min: 0, max: 2});
        requestId = randomProvider.requestRandomNumbers(ranges);

        // 5. Store pending state
        pendingFlips[requestId] = PendingFlip({
            player: msg.sender,
            wager: wager,
            netStake: netStake,
            maxPayout: maxPayout,
            headsGuess: headsGuess,
            exists: true
        });

        emit FlipStarted(requestId, msg.sender, wager, headsGuess);
    }

    function fulfillRandomness(
        uint256 requestId,
        uint256, // raw randomWord (unused)
        uint256[] memory derivedValues
    ) external override onlyRandomProvider nonReentrant {
        PendingFlip memory f = pendingFlips[requestId];
        require(f.exists, "unknown request");

        // 6. Unlock exposure
        _unlockExposure(f.maxPayout, 0);
        delete pendingFlips[requestId];

        // 7. Resolve: 0 = heads, 1 = tails
        bool isHeads = derivedValues[0] == 0;
        bool won = (isHeads == f.headsGuess);

        // 8. Pay winner
        uint256 payout;
        if (won) {
            payout = f.maxPayout;
            _payPlayer(f.player, payout);
        }

        emit FlipResolved(requestId, f.player, won, payout);
    }

    function handleRandomFailure(
        uint256 requestId,
        bytes32, // reason
        bytes calldata // details
    ) external override onlyRandomProvider nonReentrant {
        PendingFlip memory f = pendingFlips[requestId];
        if (!f.exists) return;

        // 9. On VRF failure: unlock exposure, refund the player
        _unlockExposure(f.maxPayout, 0);
        delete pendingFlips[requestId];

        _payPlayer(f.player, f.netStake);
        emit FlipFailed(requestId, f.player);
    }
}
```

### Key Patterns

**Requesting randomness:**
```solidity
RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](N);
ranges[0] = RandomDeriveLib.Range({min: 0, max: 100}); // [0, 100)
// ... more ranges as needed
uint256 requestId = randomProvider.requestRandomNumbers(ranges);
```

The `derivedValues` array in the callback will contain one value per range, already bounded to `[min, max)`.

**Exposure locking flow:**
1. `_lockExposure(maxPayout, jackpotContribution)` — before storing the pending bet.
2. `_unlockExposure(maxPayout, jackpotContribution)` — first thing in both `fulfillRandomness` and `handleRandomFailure`.
3. Always `delete` the pending bet after unlocking.

**Failure handling:**
- Always implement `handleRandomFailure`. At minimum: unlock exposure and refund the player's net stake.
- Use early `return` (not `revert`) if the request is unknown, to avoid blocking the provider.

### Constructor Arguments

| Param | Description |
|---|---|
| `token` | ERC20 token address |
| `handler` | PaymentHandler address |
| `provider` | RandomProviderV2 address |

---

## 5. Tier 3 — On-Chain Game with VRF + Jackpot

Use this tier for games where players can participate in the progressive jackpot. This adds `JackpotClient` as a second parent alongside `VRFGameBase`.

### Additions over Tier 2

```solidity
import {JackpotClient} from "./base/JackpotClient.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MyJackpotGame is VRFGameBase, JackpotClient {

    // REQUIRED: bridge the token from BaseGame to JackpotClient
    function _jackpotToken() internal view override returns (IERC20) {
        return evaToken;
    }

    // Expose setJackpot to the owner
    function setJackpot(address newJackpot) external onlyOwner {
        _setJackpot(newJackpot);
    }

    // ... rest of game logic
}
```

> **Important:** You must explicitly `import IERC20` in the concrete contract because the `_jackpotToken()` override references it, and it may not be directly visible through the inheritance chain.

### Jackpot Integration Points

There are three operations a game performs with the jackpot, all happening inside the VRF callback (`fulfillRandomness`):

#### 1. Deposit contribution

Every resolved bet should deposit its jackpot contribution to grow the pot:

```solidity
_depositToJackpot(spin.jackpotContribution);
```

This calls `jackpot.addFunds(amount)`. The game must have approved the jackpot contract for token transfers — `_setJackpot` handles this automatically.

#### 2. Enter the player

If the player is participating in the jackpot and the game's randomness lands on the jackpot outcome:

```solidity
uint256 jackpotRoll = derivedValues[JACKPOT_ROLL_INDEX];
uint256 jackpotPayout = _enterJackpot(player, betAmount, jackpotRoll);
```

The `jackpotRoll` must be a random value in `[0, jackpotRollCap)`. Request this as one of your `RandomDeriveLib.Range` entries:

```solidity
ranges[N] = RandomDeriveLib.Range({
    min: 0,
    max: uint128(jackpotRollCap)
});
```

#### 3. Pre-flight payability check

Before locking exposure, verify the jackpot can pay out:

```solidity
if (participateInJackpot) {
    _ensureJackpotPayable(betAmount);
}
```

### Jackpot Outcome Structure

The jackpot resolves outcomes based on `outcomeIndex`:

| Index | Type | Description |
|---|---|---|
| 0 | Miss | No reward |
| 1 | Consolation 1 | 1.2x bet from consolation pot |
| 2 | Consolation 2 | 1.5x bet from consolation pot |
| 3–11 | Tier win | Wins tier 0–8 prize from the corresponding tier pot |

Tier wins advance the player through the jackpot progression. Tier 8 is terminal (the grand jackpot).

### Complete Pattern (inside fulfillRandomness)

```solidity
function fulfillRandomness(
    uint256 requestId,
    uint256,
    uint256[] memory derivedValues
) external override onlyRandomProvider nonReentrant {
    PendingBet memory bet = pendingBets[requestId];
    require(bet.exists, "unknown");

    _unlockExposure(bet.maxPayout, bet.jackpotContribution);
    delete pendingBets[requestId];

    // Always deposit the jackpot contribution
    _depositToJackpot(bet.jackpotContribution);

    // Resolve game logic using derivedValues[0..N-1]
    bool won = /* your game logic */;
    uint256 payout;
    uint256 jackpotPayout;

    if (/* jackpot outcome */ && bet.participatingInJackpot) {
        uint256 jackpotRoll = derivedValues[JACKPOT_ROLL_INDEX];
        jackpotPayout = _enterJackpot(bet.player, bet.wager, jackpotRoll);
    } else if (won) {
        payout = bet.maxPayout;
        _payPlayer(bet.player, payout);
    }

    emit BetResolved(requestId, bet.player, won, payout, jackpotPayout);
}
```

---

## 6. Admin Registration Checklist

After deploying a new game contract, the ecosystem admin must register it in several places. The exact steps depend on the tier.

### All Tiers

```
1. PaymentHandler.registerGame(
       gameAddress,        // the new game contract
       payoutTarget,       // where net stakes go (usually gameAddress itself)
       feeRecipient,       // house fee wallet
       houseEdgeBps,       // e.g. 200 = 2%
       referralBps         // e.g. 200 = 2%
   )

2. PaymentHandler.setGameStatus(gameAddress, true)

3. Fund the game with liquidity:
   token.transfer(gameAddress, initialLiquidity)
```

### Tier 2 & 3 (VRF games) — add:

```
4. RandomProviderV2.setConsumerStatus(gameAddress, true, maxRanges)
   // maxRanges = number of random values per request (e.g. 7 for roulette)
```

### Tier 3 (Jackpot games) — add:

```
5. ProgressiveJackpotV2.registerGame(gameAddress, outcomes)
   // outcomes = array of OutcomeConfig structs (miss, consolations, tier awards)

6. ProgressiveJackpotV2.setGameStatus(gameAddress, true)

7. ProgressiveJackpotV2.setGameFallback(gameAddress, fallbackIndex)
   // fallbackIndex = default outcome index when no probability matches (usually 0 = miss)

8. On the game contract itself:
   game.setJackpot(jackpotAddress)
```

### Outcome Configuration for Jackpot Registration

The `outcomes` array follows this structure:

```solidity
OutcomeConfig[] outcomes;

// Index 0: Miss (fallback)
outcomes[0] = OutcomeConfig({
    enabled: true,
    tierAdvance: 0,
    tierResetTo: 0,
    consolationMultiplier: 0,    // no consolation
    awardsTier: false
});

// Index 1: Consolation 1.2x
outcomes[1] = OutcomeConfig({
    enabled: true,
    tierAdvance: 0,
    tierResetTo: 0,
    consolationMultiplier: 12000, // 1.2x in bps
    awardsTier: false
});

// Index 2: Consolation 1.5x
outcomes[2] = OutcomeConfig({
    enabled: true,
    tierAdvance: 0,
    tierResetTo: 0,
    consolationMultiplier: 15000, // 1.5x in bps
    awardsTier: false
});

// Indices 3–11: Tier 0 through Tier 8
for (uint8 tier = 0; tier < 9; tier++) {
    outcomes[3 + tier] = OutcomeConfig({
        enabled: true,
        tierAdvance: (tier == 8) ? 0 : 1, // terminal tier doesn't advance
        tierResetTo: 0,
        consolationMultiplier: 0,
        awardsTier: true
    });
}
```

---

## 7. Frontend Integration

### Player Approval (Critical Change in V5)

In V5, players must approve **each game contract** they interact with — not the PaymentHandler.

```typescript
// Before playing, ensure the player has approved the game
const allowance = await token.read.allowance([playerAddress, gameAddress]);
if (allowance < betAmount) {
    await token.write.approve([gameAddress, approvalAmount]);
}
```

If using an "approve once" UX pattern, approve `type(uint256).max`:

```typescript
await token.write.approve([gameAddress, MaxUint256]);
```

### Listening for Events

**Tier 1 (off-chain game):**
```typescript
// Watch for BetPlaced, then resolve off-chain, then call payWinner
```

**Tier 2/3 (VRF games):**
```typescript
// 1. Submit bet → get requestId from tx receipt (parse SpinStarted / FlipStarted event)
// 2. Poll: read pendingBets(requestId) until exists == false
// 3. Fetch resolution event (SpinResolved / FlipResolved) from logs
```

The polling pattern is necessary because VRF callbacks arrive in a separate transaction (typically 5–30 seconds on Arbitrum).

### Multiple Game Approvals

If your dApp has multiple games, each requires its own approval. This is intentional — it limits a player's risk exposure to one game at a time. Consider a "game lobby" UI that requests approval when a player first enters a specific game.

---

## 8. Migration from V4

### What Changed

| Aspect | V4 (Before) | V5 (After) |
|---|---|---|
| Player approval target | PaymentHandler | Individual game contracts |
| Token pull direction | Handler pulls from player | Game pulls from player, handler pulls from game |
| `paymentHandler` variable | `immutable` | Mutable with `setPaymentHandler()` |
| Handler approval | Manual in constructor | Automatic in `BaseGame` constructor + `setPaymentHandler` |
| Code reuse | Copy-paste across games | Inherit from `BaseGame` / `VRFGameBase` / `JackpotClient` |
| Jackpot approval | Manual | Automatic via `_setJackpot()` |

### For Existing Game Contracts

If migrating an existing V4 game to V5 base contracts:

1. **Replace direct token/handler logic** with base contract inheritance:
   - Remove `evaToken.safeTransferFrom(msg.sender, ...)` in play functions — use `_collectAndProcessBet` instead.
   - Remove `evaToken.safeTransfer(player, ...)` in payout logic — use `_payPlayer` instead.
   - Remove manual `safeApprove` calls in constructors — `BaseGame` handles this.
   - Remove `lockedExposure` state and manual lock/unlock math — use `_lockExposure` / `_unlockExposure`.

2. **Update constructor** to forward to the base:
   ```solidity
   // Before (V4)
   constructor(address _handler, address _token) {
       paymentHandler = IPaymentHandler(_handler);
       evaToken = IERC20(_token);
       evaToken.safeApprove(_handler, type(uint256).max);
   }

   // After (V5)
   constructor(address _handler, address _provider, address _token)
       VRFGameBase(_token, _handler, _provider)
   {}
   ```

3. **Remove duplicated access control** — `Ownable2Step` and `ReentrancyGuard` are inherited from `BaseGame`.

4. **Update frontend** — change approval target from PaymentHandler to the game contract address.

5. **Re-register** the game in PaymentHandler if the contract address changed.

### For the Frontend / SDK

The only user-facing change: **approval target**. Update every `token.approve(handlerAddress, ...)` call to `token.approve(gameAddress, ...)`. Everything else (event signatures, function signatures) remains compatible.

---

## 9. Common Pitfalls / FAQ

### Q: My game reverts with "ERC20: insufficient allowance" on the first bet.

The player has not approved your game contract. In V5, players approve the **game**, not the PaymentHandler. Ensure the frontend calls `token.approve(gameAddress, amount)` before the play transaction.

### Q: processDirectBetFromGame reverts with "Game not registered".

The admin has not registered your game in the PaymentHandler. Run:
```
PaymentHandler.registerGame(gameAddress, payoutTarget, feeRecipient, houseEdgeBps, referralBps)
PaymentHandler.setGameStatus(gameAddress, true)
```

### Q: My VRF callback never arrives.

Check that:
1. `RandomProviderV2.setConsumerStatus(gameAddress, true, maxRanges)` was called.
2. The VRF subscription has sufficient LINK funding.
3. The `RandomProviderV2` address is registered as a consumer on the Chainlink VRF coordinator.

### Q: `LiquidityShortfall` when placing a bet.

The game contract does not hold enough tokens to cover the maximum payout of the pending bet plus all other locked exposure. Fund the game with more liquidity: `token.transfer(gameAddress, amount)`.

### Q: JackpotNotConfigured revert.

The game has a non-zero `jackpotContributionBps` but `setJackpot()` was never called (or was set to `address(0)`). Call `game.setJackpot(jackpotAddress)`.

### Q: Can I change the PaymentHandler after deployment?

Yes. Call `game.setPaymentHandler(newHandlerAddress)`. This automatically revokes the old handler's approval and grants approval to the new one. You must also register the game in the new handler.

### Q: Do I need to approve the jackpot contract manually?

No. `_setJackpot()` (called via `setJackpot()`) automatically approves the jackpot contract for `type(uint256).max` tokens and revokes the old one.

### Q: What if the jackpot pot is empty when a player wins?

The jackpot degrades gracefully — `_handleOutcome` returns 0 payout if the tier pot or consolation pot is empty. The game will not revert.

### Q: How do I test my game locally?

Use Hardhat's local network. Deploy all ecosystem contracts (Token, PaymentHandler, MultiLevelReferral, RandomProviderV2, ProgressiveJackpotV2) using the deployment script pattern from `scripts/testnet/deploy-arbitrum-sepolia-v5.ts`, then deploy your game and register it. For VRF games on a local network, you will need to mock the VRF callback by calling `fulfillRandomness` directly from a test account set as the provider.

### Q: What is the minimum I need to implement for a new game?

For the absolute minimum (Tier 1), you need:
1. A contract inheriting `BaseGame`.
2. A `play()` function that calls `_collectAndProcessBet()`.
3. A `payWinner()` function that calls `_payPlayer()`.
4. Admin registration in `PaymentHandler`.

That is roughly 30 lines of custom code.
