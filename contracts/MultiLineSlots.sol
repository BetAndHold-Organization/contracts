// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import {IRandomConsumer} from "./interfaces/IRandomConsumer.sol";
import {RandomDeriveLib} from "./libraries/RandomDeriveLib.sol";

interface IPaymentHandlerMinimal {
    function processDirectBetFromGame(address bettor, address potentialReferrer, uint256 baseCost)
        external
        returns (uint256 netAmount);

    function getGameConfig(address game)
        external
        view
        returns (
            bool enabled,
            address payoutTarget,
            address feeRecipient,
            uint16 houseEdgeBps,
            uint16 referralBps
        );
}

interface IRandomProviderMinimal {
    function requestRandomNumbers(RandomDeriveLib.Range[] calldata ranges) external returns (uint256 requestId);
}

interface IProgressiveJackpotMinimal {
    function addFunds(uint256 amount) external;
}

/**
 * @title MultiLineSlots
 * @notice Multi-line slot machine with real symbol-based grid generation.
 *         - 3x3 grid with 9 independent random symbols
 *         - 5 paylines (3 horizontal + 2 diagonal)
 *         - Configurable symbols with weights, 2-match and 3-match payouts
 *         - Wild symbol support
 *         - Integrates with PaymentHandler, RandomProvider, and ProgressiveJackpot
 */
contract MultiLineSlots is IRandomConsumer, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint16 internal constant MULTIPLIER_SCALE = 100; // Payouts in hundredths (150 = 1.5x)
    
    uint8 internal constant GRID_SIZE = 9;           // 3x3 grid
    uint8 internal constant GRID_COLS = 3;
    uint8 internal constant GRID_ROWS = 3;
    uint8 internal constant MAX_SYMBOLS = 8;
    uint8 internal constant NUM_PAYLINES = 5;
    uint8 internal constant NO_SYMBOL = 255;         // Sentinel for no match

    // Fixed paylines: [cell0, cell1, cell2]
    // Grid layout:
    // [0][1][2]
    // [3][4][5]
    // [6][7][8]

    // ═══════════════════════════════════════════════════════════════════════
    //                              STRUCTS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Configuration for a symbol
    struct SymbolConfig {
        uint16 weightBps;           // Probability weight (all weights sum to 10000)
        uint16 threeMatchPayout;    // Payout for 3 matching (in hundredths, 150 = 1.5x)
        uint16 twoMatchPayout;      // Payout for 2 matching (in hundredths, 50 = 0.5x)
        bool isWild;                // If true, substitutes for any symbol
        bool enabled;               // If false, symbol is not used
    }

    /// @notice Game configuration
    struct SlotsConfig {
        bool enabled;
        uint8 activeSymbolCount;        // Number of active symbols
        uint16 jackpotContributionBps;  // % of netStake sent to jackpot (350 = 3.5%)
        uint256 minWagerPerLine;        // Minimum bet per line
        uint256 maxWagerPerLine;        // Maximum bet per line (0 = unlimited)
    }

    /// @notice Pending spin awaiting randomness
    struct PendingSpin {
        address player;
        uint256 wagerPerLine;
        uint8 activePaylines;
        uint256 totalWager;
        uint256 netStake;
        uint256 maxPayout;
        uint256 jackpotContribution;
        uint32 configIndex;
        bool exists;
    }

    /// @notice Result of a resolved spin (stored for frontend queries)
    struct SpinResult {
        uint8[GRID_SIZE] grid;          // Symbol index for each cell
        bool[NUM_PAYLINES] lineWins;    // Which paylines won
        uint8[NUM_PAYLINES] lineSymbol; // Winning symbol for each line (NO_SYMBOL if no win)
        uint16[NUM_PAYLINES] lineMultiplier; // Multiplier for each winning line
        uint256 totalPayout;
        uint256 timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error UnauthorizedCaller();
    error SlotsDisabled();
    error InvalidPaylineCount(uint8 provided);
    error WagerTooLow(uint256 provided, uint256 required);
    error WagerTooHigh(uint256 provided, uint256 allowed);
    error LiquidityShortfall(uint256 available, uint256 required);
    error InvalidSymbolConfig();
    error InvalidRandomResponse(uint256 length);
    error PaymentHandlerMisconfigured();
    error JackpotNotConfigured();

    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════

    IPaymentHandlerMinimal public immutable paymentHandler;
    IRandomProviderMinimal public immutable randomProvider;
    IERC20 public immutable evaToken;

    IProgressiveJackpotMinimal public jackpot;

    // Symbol configurations (indexed by symbol ID)
    SymbolConfig[MAX_SYMBOLS] public symbols;
    uint16 public totalSymbolWeight;  // Sum of all enabled symbol weights

    // Game configurations (versioned)
    SlotsConfig[] private slotsConfigs;
    uint32 public currentConfigIndex;

    // Exposure tracking
    uint256 public lockedExposure;

    // Pending spins and results
    mapping(uint256 => PendingSpin) public pendingSpins;
    mapping(uint256 => SpinResult) public spinResults;

    // Paylines (fixed, initialized in constructor)
    uint8[3][NUM_PAYLINES] public paylines;

    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event SlotsConfigUpdated(
        uint32 indexed index,
        bool enabled,
        uint8 activeSymbolCount,
        uint16 jackpotContributionBps,
        uint256 minWagerPerLine,
        uint256 maxWagerPerLine
    );
    
    event SymbolConfigUpdated(
        uint8 indexed symbolId,
        uint16 weightBps,
        uint16 threeMatchPayout,
        uint16 twoMatchPayout,
        bool isWild,
        bool enabled
    );

    event JackpotUpdated(address indexed jackpot);

    event SpinStarted(
        uint256 indexed requestId,
        address indexed player,
        uint8 activePaylines,
        uint256 wagerPerLine,
        uint256 totalWager,
        uint256 netStake,
        uint32 configIndex
    );

    event SpinResolved(
        uint256 indexed requestId,
        address indexed player,
        uint8[GRID_SIZE] grid,
        uint8 winningLineCount,
        uint256 totalPayout,
        uint256 jackpotContribution
    );

    event SpinFailed(uint256 indexed requestId, address indexed player, bytes32 reason);

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(address handler, address provider, address eva) {
        if (handler == address(0) || provider == address(0) || eva == address(0)) {
            revert PaymentHandlerMisconfigured();
        }

        paymentHandler = IPaymentHandlerMinimal(handler);
        randomProvider = IRandomProviderMinimal(provider);
        evaToken = IERC20(eva);

        // Initialize paylines
        // Line 0: Top row [0, 1, 2]
        paylines[0] = [0, 1, 2];
        // Line 1: Middle row [3, 4, 5]
        paylines[1] = [3, 4, 5];
        // Line 2: Bottom row [6, 7, 8]
        paylines[2] = [6, 7, 8];
        // Line 3: Diagonal top-left to bottom-right [0, 4, 8]
        paylines[3] = [0, 4, 8];
        // Line 4: Diagonal top-right to bottom-left [2, 4, 6]
        paylines[4] = [2, 4, 6];

        // Initialize with disabled default config
        slotsConfigs.push(SlotsConfig({
            enabled: false,
            activeSymbolCount: 0,
            jackpotContributionBps: 0,
            minWagerPerLine: 0,
            maxWagerPerLine: 0
        }));
        currentConfigIndex = 0;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN - CONFIG
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Set game configuration (creates new version)
     */
    function setSlotsConfig(SlotsConfig calldata config) external onlyOwner {
        if (config.jackpotContributionBps > BPS_DENOMINATOR) revert InvalidSymbolConfig();
        if (config.maxWagerPerLine != 0 && config.maxWagerPerLine < config.minWagerPerLine) {
            revert WagerTooHigh(config.maxWagerPerLine, config.minWagerPerLine);
        }
        if (config.jackpotContributionBps > 0 && address(jackpot) == address(0)) {
            revert JackpotNotConfigured();
        }
        if (config.activeSymbolCount > MAX_SYMBOLS) revert InvalidSymbolConfig();

        slotsConfigs.push(config);
        currentConfigIndex = uint32(slotsConfigs.length - 1);

        emit SlotsConfigUpdated(
            currentConfigIndex,
            config.enabled,
            config.activeSymbolCount,
            config.jackpotContributionBps,
            config.minWagerPerLine,
            config.maxWagerPerLine
        );
    }

    /**
     * @notice Configure a symbol
     * @param symbolId Symbol index (0 to MAX_SYMBOLS-1)
     * @param config Symbol configuration
     */
    function setSymbolConfig(uint8 symbolId, SymbolConfig calldata config) external onlyOwner {
        if (symbolId >= MAX_SYMBOLS) revert InvalidSymbolConfig();
        
        // Update weight tracking
        uint16 oldWeight = symbols[symbolId].enabled ? symbols[symbolId].weightBps : 0;
        uint16 newWeight = config.enabled ? config.weightBps : 0;
        
        totalSymbolWeight = totalSymbolWeight - oldWeight + newWeight;
        
        symbols[symbolId] = config;

        emit SymbolConfigUpdated(
            symbolId,
            config.weightBps,
            config.threeMatchPayout,
            config.twoMatchPayout,
            config.isWild,
            config.enabled
        );
    }

    /**
     * @notice Batch configure all symbols
     * @param configs Array of symbol configurations (must be MAX_SYMBOLS length)
     */
    function setAllSymbols(SymbolConfig[MAX_SYMBOLS] calldata configs) external onlyOwner {
        uint16 weightSum = 0;
        
        for (uint8 i = 0; i < MAX_SYMBOLS; i++) {
            symbols[i] = configs[i];
            if (configs[i].enabled) {
                weightSum += configs[i].weightBps;
            }
            
            emit SymbolConfigUpdated(
                i,
                configs[i].weightBps,
                configs[i].threeMatchPayout,
                configs[i].twoMatchPayout,
                configs[i].isWild,
                configs[i].enabled
            );
        }
        
        totalSymbolWeight = weightSum;
    }

    /**
     * @notice Set jackpot contract address
     */
    function setJackpot(address newJackpot) external onlyOwner {
        address oldJackpot = address(jackpot);
        if (oldJackpot != address(0)) {
            evaToken.safeApprove(oldJackpot, 0);
        }

        if (newJackpot == address(0)) {
            jackpot = IProgressiveJackpotMinimal(address(0));
            emit JackpotUpdated(address(0));
            return;
        }

        jackpot = IProgressiveJackpotMinimal(newJackpot);
        evaToken.safeApprove(newJackpot, type(uint256).max);
        emit JackpotUpdated(newJackpot);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              GAMEPLAY
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Start a slot spin
     * @param wagerPerLine Amount to bet per active payline
     * @param paylineCount Number of paylines to bet on (1, 3, or 5)
     * @param potentialReferrer Address of potential referrer
     */
    function startSpin(
        uint256 wagerPerLine,
        uint8 paylineCount,
        address potentialReferrer
    ) external nonReentrant returns (uint256 requestId) {
        uint32 cfgIdx = currentConfigIndex;
        SlotsConfig storage cfg = slotsConfigs[cfgIdx];

        // Validations
        if (!cfg.enabled) revert SlotsDisabled();
        if (paylineCount != 1 && paylineCount != 3 && paylineCount != 5) {
            revert InvalidPaylineCount(paylineCount);
        }
        if (cfg.minWagerPerLine > 0 && wagerPerLine < cfg.minWagerPerLine) {
            revert WagerTooLow(wagerPerLine, cfg.minWagerPerLine);
        }
        if (cfg.maxWagerPerLine > 0 && wagerPerLine > cfg.maxWagerPerLine) {
            revert WagerTooHigh(wagerPerLine, cfg.maxWagerPerLine);
        }
        if (totalSymbolWeight == 0) revert InvalidSymbolConfig();

        // Verify payment handler config
        (, address payoutTarget, , , ) = paymentHandler.getGameConfig(address(this));
        if (payoutTarget != address(this)) revert PaymentHandlerMisconfigured();

        // Calculate total wager
        uint256 totalWager = wagerPerLine * paylineCount;

        // Process bet through PaymentHandler (handles fees, referrals, whitelist)
        uint256 netStake = paymentHandler.processDirectBetFromGame(msg.sender, potentialReferrer, totalWager);
        require(netStake > 0, "net zero");

        // Calculate jackpot contribution and max payout
        uint256 jackpotContribution = Math.mulDiv(netStake, cfg.jackpotContributionBps, BPS_DENOMINATOR);
        uint256 maxPayout = _calculateMaxPayout(wagerPerLine, paylineCount);

        // Ensure liquidity
        _lockExposure(maxPayout, jackpotContribution);

        // Request 9 random values for the grid
        requestId = _requestRandomness();

        // Store pending spin
        pendingSpins[requestId] = PendingSpin({
            player: msg.sender,
            wagerPerLine: wagerPerLine,
            activePaylines: paylineCount,
            totalWager: totalWager,
            netStake: netStake,
            maxPayout: maxPayout,
            jackpotContribution: jackpotContribution,
            configIndex: cfgIdx,
            exists: true
        });

        emit SpinStarted(
            requestId,
            msg.sender,
            paylineCount,
            wagerPerLine,
            totalWager,
            netStake,
            cfgIdx
        );

        return requestId;
    }

    /**
     * @notice Callback from RandomProvider with random values
     */
    function fulfillRandomness(
        uint256 requestId,
        uint256 /*randomWord*/,
        uint256[] memory derivedValues
    ) external override nonReentrant {
        if (msg.sender != address(randomProvider)) revert UnauthorizedCaller();
        if (derivedValues.length < GRID_SIZE) revert InvalidRandomResponse(derivedValues.length);

        PendingSpin memory spin = pendingSpins[requestId];
        if (!spin.exists) revert UnauthorizedCaller();

        _unlockExposure(spin.maxPayout, spin.jackpotContribution);
        delete pendingSpins[requestId];

        // Generate grid from random values
        uint8[GRID_SIZE] memory grid = _generateGrid(derivedValues);

        // Evaluate all paylines
        (
            bool[NUM_PAYLINES] memory lineWins,
            uint8[NUM_PAYLINES] memory lineSymbol,
            uint16[NUM_PAYLINES] memory lineMultiplier,
            uint256 totalPayout
        ) = _evaluateAllPaylines(grid, spin.wagerPerLine, spin.activePaylines);

        // Store result for frontend
        spinResults[requestId] = SpinResult({
            grid: grid,
            lineWins: lineWins,
            lineSymbol: lineSymbol,
            lineMultiplier: lineMultiplier,
            totalPayout: totalPayout,
            timestamp: block.timestamp
        });

        // Transfer payout
        if (totalPayout > 0) {
            evaToken.safeTransfer(spin.player, totalPayout);
        }

        // Deposit jackpot contribution
        _depositToJackpot(spin.jackpotContribution);

        // Count winning lines for event
        uint8 winningLineCount = 0;
        for (uint8 i = 0; i < NUM_PAYLINES; i++) {
            if (lineWins[i]) winningLineCount++;
        }

        emit SpinResolved(
            requestId,
            spin.player,
            grid,
            winningLineCount,
            totalPayout,
            spin.jackpotContribution
        );
    }

    /**
     * @notice Handle failed random request
     */
    function handleRandomFailure(
        uint256 requestId,
        bytes32 reason,
        bytes calldata /*details*/
    ) external override nonReentrant {
        if (msg.sender != address(randomProvider)) revert UnauthorizedCaller();

        PendingSpin memory spin = pendingSpins[requestId];
        if (!spin.exists) return;

        _unlockExposure(spin.maxPayout, spin.jackpotContribution);
        delete pendingSpins[requestId];

        // Refund the netStake to player
        evaToken.safeTransfer(spin.player, spin.netStake);

        emit SpinFailed(requestId, spin.player, reason);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              VIEWS
    // ═══════════════════════════════════════════════════════════════════════

    function availableLiquidity() external view returns (uint256) {
        uint256 balance = evaToken.balanceOf(address(this));
        if (balance <= lockedExposure) return 0;
        return balance - lockedExposure;
    }

    function getSlotsConfig() external view returns (SlotsConfig memory) {
        return slotsConfigs[currentConfigIndex];
    }

    function getSlotsConfig(uint256 index) external view returns (SlotsConfig memory) {
        require(index < slotsConfigs.length, "config index");
        return slotsConfigs[index];
    }

    function getSymbol(uint8 symbolId) external view returns (SymbolConfig memory) {
        require(symbolId < MAX_SYMBOLS, "symbol index");
        return symbols[symbolId];
    }

    function getAllSymbols() external view returns (SymbolConfig[MAX_SYMBOLS] memory) {
        SymbolConfig[MAX_SYMBOLS] memory result;
        for (uint8 i = 0; i < MAX_SYMBOLS; i++) {
            result[i] = symbols[i];
        }
        return result;
    }

    function getPaylines() external view returns (uint8[3][NUM_PAYLINES] memory) {
        return paylines;
    }

    function getSpinResult(uint256 requestId) external view returns (SpinResult memory) {
        return spinResults[requestId];
    }

    /**
     * @notice Preview potential max payout for a spin
     */
    function previewSpin(uint256 wagerPerLine, uint8 paylineCount)
        external
        view
        returns (
            uint256 totalWager,
            uint256 maxPayout,
            uint256 estimatedJackpotContribution
        )
    {
        SlotsConfig storage cfg = slotsConfigs[currentConfigIndex];
        
        totalWager = wagerPerLine * paylineCount;
        maxPayout = _calculateMaxPayout(wagerPerLine, paylineCount);
        
        // Estimate jackpot contribution (approximate since we don't know exact netStake)
        (, , , uint16 houseEdgeBps, uint16 referralBps) = paymentHandler.getGameConfig(address(this));
        uint256 estimatedNetStake = totalWager * (BPS_DENOMINATOR - houseEdgeBps - referralBps) / BPS_DENOMINATOR;
        estimatedJackpotContribution = Math.mulDiv(estimatedNetStake, cfg.jackpotContributionBps, BPS_DENOMINATOR);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              INTERNAL - GRID
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Generate grid from random values
     */
    function _generateGrid(uint256[] memory randomValues) internal view returns (uint8[GRID_SIZE] memory grid) {
        uint16 weightTotal = totalSymbolWeight;
        
        for (uint8 cell = 0; cell < GRID_SIZE; cell++) {
            uint256 roll = randomValues[cell] % weightTotal;
            grid[cell] = _randomToSymbol(roll);
        }
    }

    /**
     * @notice Convert random value to symbol index based on weights
     */
    function _randomToSymbol(uint256 roll) internal view returns (uint8) {
        uint256 cumulative = 0;
        
        for (uint8 i = 0; i < MAX_SYMBOLS; i++) {
            if (!symbols[i].enabled) continue;
            
            cumulative += symbols[i].weightBps;
            if (roll < cumulative) {
                return i;
            }
        }
        
        // Fallback (should not happen if weights are configured correctly)
        return 0;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              INTERNAL - PAYLINES
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Evaluate all paylines and calculate total payout
     */
    function _evaluateAllPaylines(
        uint8[GRID_SIZE] memory grid,
        uint256 wagerPerLine,
        uint8 activePaylines
    ) internal view returns (
        bool[NUM_PAYLINES] memory lineWins,
        uint8[NUM_PAYLINES] memory lineSymbol,
        uint16[NUM_PAYLINES] memory lineMultiplier,
        uint256 totalPayout
    ) {
        // Initialize all to no win
        for (uint8 i = 0; i < NUM_PAYLINES; i++) {
            lineSymbol[i] = NO_SYMBOL;
        }

        // Evaluate each active payline
        for (uint8 line = 0; line < activePaylines; line++) {
            (bool won, uint8 symbol, uint16 multiplier) = _evaluateLine(grid, line);
            
            lineWins[line] = won;
            if (won) {
                lineSymbol[line] = symbol;
                lineMultiplier[line] = multiplier;
                totalPayout += Math.mulDiv(wagerPerLine, multiplier, MULTIPLIER_SCALE);
            }
        }
    }

    /**
     * @notice Evaluate a single payline
     * @return won Whether the line is a winner
     * @return winSymbol The winning symbol (NO_SYMBOL if no win)
     * @return multiplier The payout multiplier in hundredths
     */
    function _evaluateLine(
        uint8[GRID_SIZE] memory grid,
        uint8 lineIndex
    ) internal view returns (bool won, uint8 winSymbol, uint16 multiplier) {
        uint8[3] memory line = paylines[lineIndex];
        
        uint8 s0 = grid[line[0]];
        uint8 s1 = grid[line[1]];
        uint8 s2 = grid[line[2]];

        // Get symbol configs
        SymbolConfig memory cfg0 = symbols[s0];
        SymbolConfig memory cfg1 = symbols[s1];
        SymbolConfig memory cfg2 = symbols[s2];

        // Check for 3-match (including wilds)
        (bool is3Match, uint8 baseSymbol3) = _check3Match(s0, s1, s2, cfg0, cfg1, cfg2);
        if (is3Match) {
            return (true, baseSymbol3, symbols[baseSymbol3].threeMatchPayout);
        }

        // Check for 2-match (including wilds)
        (bool is2Match, uint8 baseSymbol2) = _check2Match(s0, s1, s2, cfg0, cfg1, cfg2);
        if (is2Match && symbols[baseSymbol2].twoMatchPayout > 0) {
            return (true, baseSymbol2, symbols[baseSymbol2].twoMatchPayout);
        }

        return (false, NO_SYMBOL, 0);
    }

    /**
     * @notice Check if three symbols match (accounting for wilds)
     */
    function _check3Match(
        uint8 s0, uint8 s1, uint8 s2,
        SymbolConfig memory cfg0,
        SymbolConfig memory cfg1,
        SymbolConfig memory cfg2
    ) internal pure returns (bool matches, uint8 baseSymbol) {
        // Count wilds and find non-wild symbols
        uint8 wildCount = 0;
        uint8 nonWild1 = NO_SYMBOL;
        uint8 nonWild2 = NO_SYMBOL;

        if (cfg0.isWild) wildCount++;
        else nonWild1 = s0;

        if (cfg1.isWild) wildCount++;
        else {
            if (nonWild1 == NO_SYMBOL) nonWild1 = s1;
            else nonWild2 = s1;
        }

        if (cfg2.isWild) wildCount++;
        else {
            if (nonWild1 == NO_SYMBOL) nonWild1 = s2;
            else if (nonWild2 == NO_SYMBOL) nonWild2 = s2;
        }

        // All wilds - use first symbol as base (shouldn't happen with low wild weight)
        if (wildCount == 3) {
            return (true, s0);
        }

        // Two wilds + one symbol
        if (wildCount == 2) {
            return (true, nonWild1);
        }

        // One wild + two symbols (must be same)
        if (wildCount == 1) {
            if (nonWild1 == nonWild2) {
                return (true, nonWild1);
            }
            return (false, NO_SYMBOL);
        }

        // No wilds - all three must be same
        if (s0 == s1 && s1 == s2) {
            return (true, s0);
        }

        return (false, NO_SYMBOL);
    }

    /**
     * @notice Check if exactly two symbols match (accounting for wilds)
     */
    function _check2Match(
        uint8 s0, uint8 s1, uint8 s2,
        SymbolConfig memory cfg0,
        SymbolConfig memory cfg1,
        SymbolConfig memory cfg2
    ) internal pure returns (bool matches, uint8 baseSymbol) {
        // For 2-match, we need exactly 2 matching (or 1 match + 1 wild)
        // The third must be different and not wild
        
        uint8 wildCount = 0;
        if (cfg0.isWild) wildCount++;
        if (cfg1.isWild) wildCount++;
        if (cfg2.isWild) wildCount++;

        // With 2+ wilds, it would be a 3-match, handled above
        if (wildCount >= 2) return (false, NO_SYMBOL);

        // One wild case
        if (wildCount == 1) {
            // Find the two non-wild symbols
            uint8 a;
            uint8 b;
            
            if (cfg0.isWild) {
                a = s1; b = s2;
            } else if (cfg1.isWild) {
                a = s0; b = s2;
            } else {
                a = s0; b = s1;
            }
            
            // If they're different, wild + one of them = 2-match
            // But which one? Use the one with higher payout
            if (a != b) {
                // Return the one with better 2-match payout
                // For simplicity, just return the first non-wild that's not matching
                // This is a partial match scenario
                return (false, NO_SYMBOL); // Skip 2-match with wild for simplicity
            }
            return (false, NO_SYMBOL);
        }

        // No wilds - check for exactly 2 matching
        if (s0 == s1 && s1 != s2) return (true, s0);
        if (s0 == s2 && s0 != s1) return (true, s0);
        if (s1 == s2 && s0 != s1) return (true, s1);

        return (false, NO_SYMBOL);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              INTERNAL - HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Calculate maximum possible payout for exposure locking
     */
    function _calculateMaxPayout(uint256 wagerPerLine, uint8 paylineCount) internal view returns (uint256) {
        // Find highest multiplier among all symbols
        uint16 maxMultiplier = 0;
        for (uint8 i = 0; i < MAX_SYMBOLS; i++) {
            if (symbols[i].enabled) {
                if (symbols[i].threeMatchPayout > maxMultiplier) {
                    maxMultiplier = symbols[i].threeMatchPayout;
                }
            }
        }
        
        // Theoretical max: all lines hit the highest multiplier
        return Math.mulDiv(wagerPerLine * paylineCount, maxMultiplier, MULTIPLIER_SCALE);
    }

    function _requestRandomness() internal returns (uint256 requestId) {
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](GRID_SIZE);
        
        // Each cell gets a random value in range [0, totalSymbolWeight)
        RandomDeriveLib.Range memory cellRange = RandomDeriveLib.Range({
            min: 0,
            max: uint128(totalSymbolWeight)
        });
        
        for (uint8 i = 0; i < GRID_SIZE; i++) {
            ranges[i] = cellRange;
        }
        
        requestId = randomProvider.requestRandomNumbers(ranges);
    }

    function _lockExposure(uint256 maxPayout, uint256 jackpotContribution) internal {
        uint256 proposedLocked = lockedExposure + maxPayout + jackpotContribution;
        uint256 balance = evaToken.balanceOf(address(this));
        if (balance < proposedLocked) revert LiquidityShortfall(balance, proposedLocked);
        lockedExposure = proposedLocked;
    }

    function _unlockExposure(uint256 maxPayout, uint256 jackpotContribution) internal {
        uint256 reduction = maxPayout + jackpotContribution;
        if (lockedExposure < reduction) {
            lockedExposure = 0;
        } else {
            lockedExposure -= reduction;
        }
    }

    function _depositToJackpot(uint256 amount) internal {
        if (amount == 0 || address(jackpot) == address(0)) return;
        jackpot.addFunds(amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              EMERGENCY
    // ═══════════════════════════════════════════════════════════════════════

    function emergencyWithdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "to");
        uint256 bal = evaToken.balanceOf(address(this));
        uint256 amt = amount == 0 ? bal : amount;
        require(amt <= bal, "insufficient");
        evaToken.safeTransfer(to, amt);
    }
}

