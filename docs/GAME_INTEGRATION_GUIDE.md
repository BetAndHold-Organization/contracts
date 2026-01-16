# Game Integration Guide

This guide explains how to integrate external games with The Burning Games payment, referral, and jackpot system.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Integration Options](#integration-options)
- [Option 1: PaymentOnlyGameAdapter](#option-1-paymentonlygameadapter-simplest)
- [Option 2: Full On-Chain Game with VRF](#option-2-full-on-chain-game-with-vrf)
- [Registering Your Game](#registering-your-game)
- [Payment Flow](#payment-flow)
- [Jackpot System](#jackpot-system)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           PLAYER                                     │
│                    (has EVA tokens)                                  │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ approve() + play()
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       YOUR GAME                                      │
│           (Roulette, Slots, External Game, etc.)                     │
│                                                                      │
│   Calls: handler.processDirectBetFromGame(player, referrer, amount) │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    PAYMENT HANDLER                                   │
│                                                                      │
│   1. Takes tokens from player (via approve)                         │
│   2. Deducts house edge (e.g., 2%) → sends to feeRecipient          │
│   3. Deducts referral fee (e.g., 2%) → sends to referral system     │
│   4. Returns netAmount (96%) to the GAME                            │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
┌─────────────────────────┐   ┌─────────────────────────────────────┐
│   MULTI-LEVEL REFERRAL   │   │         GAME (receives net)         │
│                          │   │                                     │
│ Distributes referral %   │   │ 1. Calculates jackpot contribution │
│ across 5 levels:         │   │ 2. Calls jackpot.addFunds(amount)  │
│ - L1: 70%               │   │    (jackpot PULLS tokens from game) │
│ - L2: 12%               │   │ 3. Calls jackpot.processJackpotEntry│
│ - L3: 9%                │   │ 4. Runs game logic with stake       │
│ - L4: 6%                │   │ 5. Pays winner if applicable        │
│ - L5: 3%                │   └─────────────────────────────────────┘
└─────────────────────────┘               │
                                          ▼
                            ┌─────────────────────────────────────┐
                            │      PROGRESSIVE JACKPOT V2         │
                            │                                     │
                            │ - addFunds() pulls tokens from game │
                            │ - Distributes to 9 tier pots        │
                            │ - processJackpotEntry() rolls for   │
                            │   tier win or consolation           │
                            │ - Pays jackpot wins to player       │
                            └─────────────────────────────────────┘

**Important**: Game must approve jackpot contract to spend its tokens 
before calling `addFunds()`. See `setJackpot()` in the examples.
```

---

## Integration Options

| Option | Use Case | Complexity | On-Chain Logic |
|--------|----------|------------|----------------|
| **PaymentOnlyGameAdapter** | Unity/Unreal/Web games with off-chain logic | Simple | No |
| **Full On-Chain Game** | Provably fair, trustless games with VRF | Complex | Yes |

---

## Option 1: PaymentOnlyGameAdapter (Simplest)

Best for external games (Unity, Unreal, web-based) where game logic runs off-chain. The adapter handles payment processing but **jackpot contributions must be handled separately** by your backend.

### How It Works

1. Player approves tokens to PaymentHandler
2. Your backend calls `adapter.play()` to process the bet
3. Your backend sends jackpot contribution to jackpot contract
4. Game logic runs off-chain (your server)
5. If player wins, backend calls `adapter.payWinner()`

### Contract Interface

```solidity
contract PaymentOnlyGameAdapter {
    // Process a bet - handles fees and referrals automatically
    function play(
        uint256 amount,           // Bet amount in EVA
        address potentialReferrer, // Who referred this player (or address(0))
        bytes32 gameId            // Your game's unique identifier
    ) external;
    
    // Pay a winner (only owner can call)
    function payWinner(
        address player,           // Winner's address
        uint256 amount            // Amount to pay
    ) external;
    
    // Withdraw liquidity (only owner)
    function withdraw(address to, uint256 amount) external;
}
```

### JavaScript/TypeScript Example

```typescript
import { parseEther } from 'viem';

const JACKPOT_CONTRIB_BPS = 350; // 3.5%

// SETUP (once): Adapter must approve jackpot to pull tokens
async function setupJackpotApproval() {
    // The adapter owner must approve jackpot to spend adapter's tokens
    // This is done by transferring tokens to adapter, then adapter approves jackpot
    // Or use a custom adapter that handles this internally
}

// 1. Player approves tokens BEFORE playing
async function approveTokens(playerWallet, amount) {
    await token.write.approve([handlerAddress, amount], { account: playerWallet });
}

// 2. Process a bet with jackpot contribution
async function placeBet(betAmount, referrerAddress, gameId) {
    // Convert gameId string to bytes32
    const gameIdBytes32 = stringToBytes32(gameId);
    
    // Process bet through adapter (handles fees, returns net to adapter)
    await adapter.write.play([
        betAmount,
        referrerAddress || "0x0000000000000000000000000000000000000000",
        gameIdBytes32
    ]);
    
    // Calculate net amount after fees (96% if 2% house + 2% referral)
    const netAmount = (betAmount * 96n) / 100n;
    
    // Calculate jackpot contribution (3.5% of net)
    const jackpotContrib = (netAmount * BigInt(JACKPOT_CONTRIB_BPS)) / 10000n;
    
    // IMPORTANT: Jackpot contribution requires:
    // 1. Your game/adapter must have tokens
    // 2. Your game/adapter must have approved jackpot to spend tokens
    // 3. Call jackpot.addFunds() which PULLS tokens from your contract
    // 
    // For PaymentOnlyGameAdapter, you need a custom solution or 
    // handle jackpot separately. See Full On-Chain Game for proper integration.
    
    return { netAmount, jackpotContrib };
}

// 3. Pay winner (called from your backend with owner wallet)
async function payWinner(playerAddress, winAmount) {
    await adapter.write.payWinner([playerAddress, winAmount]);
}
```

> **Note**: The `PaymentOnlyGameAdapter` doesn't natively support jackpot contributions. 
> For full jackpot integration, use a **Full On-Chain Game** (Option 2) which properly 
> handles the approval and `addFunds` flow.

### Unity C# Example

```csharp
using Nethereum.Web3;
using Nethereum.Contracts;
using System.Numerics;

public class GamePaymentManager : MonoBehaviour
{
    // Step 1: Approve tokens (call once per session or when needed)
    public async Task ApproveTokens(string playerAddress, BigInteger amount)
    {
        var web3 = new Web3(playerWallet);
        var token = web3.Eth.GetContract(ERC20_ABI, tokenAddress);
        var approveFunction = token.GetFunction("approve");
        
        await approveFunction.SendTransactionAsync(
            playerAddress,
            handlerAddress,
            amount
        );
    }
    
    // Step 2: Place bet (without jackpot - use Full On-Chain Game for jackpot)
    public async Task<BigInteger> PlaceBet(BigInteger amount, string referrer, string gameId)
    {
        var web3 = new Web3(backendWallet);
        var adapter = web3.Eth.GetContract(ADAPTER_ABI, adapterAddress);
        
        // Process bet through adapter
        byte[] gameIdBytes = Encoding.UTF8.GetBytes(gameId).PadRight(32);
        var playFunction = adapter.GetFunction("play");
        await playFunction.SendTransactionAsync(
            backendAddress,
            amount,
            string.IsNullOrEmpty(referrer) ? AddressZero : referrer,
            gameIdBytes
        );
        
        // Calculate net amount after fees (96% if 2% house + 2% referral)
        BigInteger netAmount = amount * 96 / 100;
        
        return netAmount;
    }
    
    // Step 3: Pay winner (backend only)
    public async Task PayWinner(string winnerAddress, BigInteger amount)
    {
        var web3 = new Web3(backendWallet);
        var adapter = web3.Eth.GetContract(ADAPTER_ABI, adapterAddress);
        var payFunction = adapter.GetFunction("payWinner");
        
        await payFunction.SendTransactionAsync(
            backendAddress,
            winnerAddress,
            amount
        );
    }
}
```

> **Note**: For jackpot integration, use a **Full On-Chain Game** (Option 2) which 
> handles token approvals and the `addFunds` → `processJackpotEntry` flow correctly.
```

---

## Option 2: Full On-Chain Game with VRF

For fully trustless, provably fair games where all logic runs on-chain with Chainlink VRF for randomness.

### Complete Game Structure with Jackpot

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IPaymentHandler {
    function processDirectBetFromGame(
        address bettor,
        address potentialReferrer,
        uint256 baseCost
    ) external returns (uint256 netAmount);
}

interface IProgressiveJackpotV2 {
    function addFunds(uint256 amount) external;
    function processJackpotEntry(
        address player,
        uint256 betAmount,
        uint256 roll
    ) external returns (uint256 payout);
}

interface IRandomProvider {
    function requestRandomNumber(uint256 maxNumber) external returns (uint256 requestId);
}

interface IRandomConsumer {
    function fulfillRandomness(
        uint256 requestId,
        uint256 randomWord,
        uint256[] memory derivedValues
    ) external;
}

contract MyVRFGame is IRandomConsumer, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    
    IERC20 public immutable token;
    IPaymentHandler public immutable handler;
    IRandomProvider public randomProvider;
    IProgressiveJackpotV2 public jackpot;
    
    uint16 public constant JACKPOT_CONTRIB_BPS = 350; // 3.5% to jackpot
    
    struct PendingBet {
        address player;
        uint256 netAmount;
        uint256 jackpotContrib;
        uint256 multiplier;
        bool settled;
    }
    
    mapping(uint256 => PendingBet) public pendingBets;
    
    event BetPlaced(uint256 indexed requestId, address indexed player, uint256 amount, uint256 multiplier);
    event BetSettled(uint256 indexed requestId, address indexed player, uint256 payout, uint256 jackpotWin);
    event JackpotUpdated(address indexed newJackpot);
    
    constructor(
        address _token, 
        address _handler,
        address _randomProvider
    ) {
        token = IERC20(_token);
        handler = IPaymentHandler(_handler);
        randomProvider = IRandomProvider(_randomProvider);
    }
    
    /**
     * @notice Set the jackpot contract and approve it to pull tokens
     * @dev This approval allows jackpot.addFunds() to work
     */
    function setJackpot(address _jackpot) external onlyOwner {
        // Remove approval from old jackpot
        if (address(jackpot) != address(0)) {
            token.safeApprove(address(jackpot), 0);
        }
        
        jackpot = IProgressiveJackpotV2(_jackpot);
        
        // IMPORTANT: Approve new jackpot to pull tokens from this contract
        // This is required for jackpot.addFunds() to work
        if (_jackpot != address(0)) {
            token.safeApprove(_jackpot, type(uint256).max);
        }
        
        emit JackpotUpdated(_jackpot);
    }
    
    /**
     * @notice Place a bet - VRF will be called for randomness
     * @param amount Bet amount in tokens
     * @param multiplier Target multiplier (e.g., 200 = 2x)
     * @param referrer Address of potential referrer
     */
    function play(
        uint256 amount,
        uint256 multiplier,
        address referrer
    ) external nonReentrant returns (uint256 requestId) {
        require(multiplier >= 101 && multiplier <= 10000, "Invalid multiplier");
        
        // 1. Process payment through handler
        //    Deducts house edge and referral fees, returns net to this contract
        uint256 netAmount = handler.processDirectBetFromGame(
            msg.sender,
            referrer,
            amount
        );
        
        // 2. Calculate jackpot contribution
        uint256 jackpotContrib = (netAmount * JACKPOT_CONTRIB_BPS) / 10000;
        uint256 stake = netAmount - jackpotContrib;
        
        // 3. Request random number from VRF (2 values: game roll + jackpot roll)
        requestId = randomProvider.requestRandomNumber(10000);
        
        // 4. Store bet details for fulfillment (including jackpot contribution)
        pendingBets[requestId] = PendingBet({
            player: msg.sender,
            netAmount: stake,
            jackpotContrib: jackpotContrib,
            multiplier: multiplier,
            settled: false
        });
        
        emit BetPlaced(requestId, msg.sender, stake, multiplier);
    }
    
    /**
     * @notice Called by RandomProvider when VRF responds
     */
    function fulfillRandomness(
        uint256 requestId,
        uint256 /* randomWord */,
        uint256[] memory derivedValues
    ) external override {
        require(msg.sender == address(randomProvider), "Only provider");
        
        PendingBet storage bet = pendingBets[requestId];
        require(bet.player != address(0), "Unknown request");
        require(!bet.settled, "Already settled");
        
        bet.settled = true;
        
        // Get random values
        uint256 gameRoll = derivedValues[0];      // 0-9999 for game
        uint256 jackpotRoll = derivedValues.length > 1 ? derivedValues[1] : gameRoll;
        
        // Process jackpot contribution and entry
        uint256 jackpotWin = 0;
        if (address(jackpot) != address(0) && bet.jackpotContrib > 0) {
            // IMPORTANT: addFunds() pulls tokens from this contract (requires approval)
            // The approval was set in setJackpot()
            jackpot.addFunds(bet.jackpotContrib);
            
            // Process player's jackpot entry with the random roll
            jackpotWin = jackpot.processJackpotEntry(bet.player, bet.jackpotContrib, jackpotRoll);
        }
        
        // Calculate win threshold based on multiplier
        // e.g., 2x multiplier = 50% chance (5000 threshold)
        uint256 winThreshold = 10000 * 100 / bet.multiplier;
        
        uint256 payout = 0;
        if (gameRoll < winThreshold) {
            // Player wins!
            payout = (bet.netAmount * bet.multiplier) / 100;
            token.safeTransfer(bet.player, payout);
        }
        
        emit BetSettled(requestId, bet.player, payout, jackpotWin);
        
        delete pendingBets[requestId];
    }
    
    /**
     * @notice Withdraw liquidity (owner only)
     */
    function withdraw(address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }
}
```

### Requesting Multiple Random Values

When calling `requestRandomNumber`, you can request multiple derived values by registering your game with a higher `maxRanges`:

```solidity
// In RandomProvider registration:
randomProvider.setConsumerStatus(gameAddress, true, 7); // Up to 7 random values

// In your game, request with max number:
uint256 requestId = randomProvider.requestRandomNumber(10000);

// In fulfillRandomness, you'll receive:
// derivedValues[0] = first random 0-9999
// derivedValues[1] = second random 0-9999
// ... etc
```

---

## Registering Your Game

After deploying your game contract, register it with the system:

### 1. Register in PaymentHandler

```solidity
// From owner wallet
handler.registerGame(
    gameAddress,          // Your game contract
    payoutTarget,         // Where netAmount goes (usually gameAddress)
    feeRecipient,         // Where house edge goes (house wallet)
    200,                  // houseEdgeBps: 2% house edge
    200                   // referralBps: 2% referral fee
);

// Enable the game
handler.setGameStatus(gameAddress, true);
```

### 2. Register in RandomProvider (for VRF)

```solidity
randomProvider.setConsumerStatus(
    gameAddress,          // Your game contract
    true,                 // Enabled
    7                     // Max ranges (number of random values needed)
);
```

### 3. Register in Jackpot (for jackpot contributions)

```solidity
// Build outcomes array
OutcomeConfig[] memory outcomes = new OutcomeConfig[](12);

// Outcome 0: Pure lose
outcomes[0] = OutcomeConfig({
    enabled: true,
    tierAdvance: 0,
    tierResetTo: 0,
    consolationMultiplier: 0,
    awardsTier: false
});

// Outcome 1: Consolation 1.2x
outcomes[1] = OutcomeConfig({
    enabled: true,
    tierAdvance: 0,
    tierResetTo: 0,
    consolationMultiplier: 12000, // 1.2x
    awardsTier: false
});

// Outcome 2: Consolation 1.5x
outcomes[2] = OutcomeConfig({
    enabled: true,
    tierAdvance: 0,
    tierResetTo: 0,
    consolationMultiplier: 15000, // 1.5x
    awardsTier: false
});

// Outcomes 3-11: Tier awards (one per tier)
for (uint8 i = 0; i < 9; i++) {
    outcomes[3 + i] = OutcomeConfig({
        enabled: true,
        tierAdvance: i == 8 ? 0 : 1, // Terminal tier doesn't advance
        tierResetTo: 0,
        consolationMultiplier: 0,
        awardsTier: true
    });
}

// Register game with outcomes
jackpot.registerGame(gameAddress, outcomes);
jackpot.setGameStatus(gameAddress, true);
jackpot.setGameFallback(gameAddress, 0); // 0 = lose outcome as fallback
```

---

## Payment Flow

When a player places a 100 EVA bet:

| Step | Amount | Recipient | Description |
|------|--------|-----------|-------------|
| 1. Player bets | 100 EVA | - | Taken from player |
| 2. House edge | 2 EVA | House wallet | 2% fee |
| 3. Referral fee | 2 EVA | Referral system | Distributed across 5 levels |
| 4. **Net to game** | **96 EVA** | Game contract | What your game receives |
| 5. Jackpot contrib | 3.36 EVA | Jackpot | 3.5% of net |
| 6. **Game stake** | **92.64 EVA** | Game logic | Used for win/lose calculation |

### Referral Distribution (of the 2 EVA)

| Level | Share | Amount |
|-------|-------|--------|
| Level 1 (direct referrer) | 70% | 1.40 EVA |
| Level 2 | 12% | 0.24 EVA |
| Level 3 | 9% | 0.18 EVA |
| Level 4 | 6% | 0.12 EVA |
| Level 5 | 3% | 0.06 EVA |

---

## Jackpot System

The ProgressiveJackpotV2 has a **9-tier progressive system** with per-tier pots.

### Tier Configuration

| Tier | Entry Cost | Pot Share | Win Prize |
|------|------------|-----------|-----------|
| 0 | 0.5 EVA | 10% | Tier 0 pot balance |
| 1 | 0.5 EVA | 10% | Tier 1 pot balance |
| 2 | 0.5 EVA | 10% | Tier 2 pot balance |
| 3 | 1 EVA | 10% | Tier 3 pot balance |
| 4 | 1 EVA | 10% | Tier 4 pot balance |
| 5 | 1 EVA | 10% | Tier 5 pot balance |
| 6 | 2 EVA | 10% | Tier 6 pot balance |
| 7 | 2 EVA | 10% | Tier 7 pot balance |
| 8 | 3 EVA | 20% | Tier 8 pot balance |

### How Jackpot Contributions Work

**Flow:**
1. Game approves jackpot to spend tokens (once, in `setJackpot()`)
2. Game calls `jackpot.addFunds(3.36 EVA)` 
3. Jackpot pulls tokens from game via `safeTransferFrom`
4. Jackpot distributes to tier pots based on shares
5. Game calls `jackpot.processJackpotEntry(player, amount, roll)` for player's chance

When your game contributes 3.36 EVA to the jackpot:

| Tier Pot | Share | Amount Added |
|----------|-------|--------------|
| Tier 0 | 10% | 0.336 EVA |
| Tier 1 | 10% | 0.336 EVA |
| Tier 2 | 10% | 0.336 EVA |
| Tier 3 | 10% | 0.336 EVA |
| Tier 4 | 10% | 0.336 EVA |
| Tier 5 | 10% | 0.336 EVA |
| Tier 6 | 10% | 0.336 EVA |
| Tier 7 | 10% | 0.336 EVA |
| Tier 8 | 20% | 0.672 EVA |

### Probability Scaling

- **Starting probability**: 0.1% per tier
- **Max probability**: 20% per tier
- **Increment per entry**: 0.03% per entry

Probability increases with each entry until someone wins that tier, then resets to minimum.

### Possible Outcomes When Processing Jackpot Entry

| Outcome | Probability | Result |
|---------|-------------|--------|
| Lose | ~82% | Nothing extra |
| Consolation 1.2x | 12% | Bet × 1.2 returned |
| Consolation 1.5x | 6% | Bet × 1.5 returned |
| **Win Current Tier** | 0.1%-20% | Entire tier pot balance |

When a player wins a tier:
1. They receive that tier's entire pot balance
2. They advance to the next tier (or reset if tier 8)
3. The tier's probability resets to minimum

---

## Need Help?

- Check the example contracts in `/contracts/`
- Review deployment scripts in `/scripts/mainnet/` and `/scripts/testnet/`
- Look at `SingleRandomRouletteV2.sol` for a complete on-chain game example with jackpot integration
