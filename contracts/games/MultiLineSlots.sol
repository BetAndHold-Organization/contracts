// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import {PushVRFGame} from "./base/PushVRFGame.sol";
import {RandomDeriveLib} from "../libraries/RandomDeriveLib.sol";

/**
 * @title MultiLineSlots
 * @notice Multi-line slot machine on the PushVRFGame canonical base.
 *         - 3x3 grid with 9 independent random symbols
 *         - 5 paylines (3 horizontal + 2 diagonal)
 *         - Configurable symbols with weights, 2-match and 3-match payouts
 *         - Wild symbol support
 *         - Integrates with PaymentHandler, RandomProvider, and ProgressiveJackpot via PushVRFGame
 */
contract MultiLineSlots is PushVRFGame {

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    bytes32 public constant START_SPIN_TYPEHASH = keccak256(
        "StartSpin(address game,address player,uint256 wagerPerLine,uint8 paylineCount,address potentialReferrer,uint256 nonce,uint256 deadline)"
    );

    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint16 internal constant MULTIPLIER_SCALE = 100;

    uint8 internal constant GRID_SIZE = 9;
    uint8 internal constant GRID_COLS = 3;
    uint8 internal constant GRID_ROWS = 3;
    uint8 internal constant MAX_SYMBOLS = 8;
    uint8 internal constant NUM_PAYLINES = 5;
    uint8 internal constant NO_SYMBOL = 255;

    // ═══════════════════════════════════════════════════════════════════════
    //                              STRUCTS
    // ═══════════════════════════════════════════════════════════════════════

    struct SymbolConfig {
        uint16 weightBps;
        uint16 threeMatchPayout;
        uint16 twoMatchPayout;
        bool isWild;
        bool enabled;
    }

    struct SlotsConfig {
        bool enabled;
        uint8 activeSymbolCount;
        uint256 minWagerPerLine;
        uint256 maxWagerPerLine;
    }

    struct PendingSpin {
        address player;
        uint256 wagerPerLine;
        uint8 activePaylines;
        uint256 totalWager;
        uint256 netStake;
        uint256 maxPayout;
        uint32 configIndex;
        bool exists;
    }

    struct SpinResult {
        uint8[GRID_SIZE] grid;
        bool[NUM_PAYLINES] lineWins;
        uint8[NUM_PAYLINES] lineSymbol;
        uint16[NUM_PAYLINES] lineMultiplier;
        uint256 totalPayout;
        uint256 timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error SlotsDisabled();
    error InvalidPaylineCount(uint8 provided);
    error WagerTooLow(uint256 provided, uint256 required);
    error WagerTooHigh(uint256 provided, uint256 allowed);
    error InvalidSymbolConfig();
    error InvalidRandomResponse(uint256 length);

    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════

    SymbolConfig[MAX_SYMBOLS] public symbols;
    uint16 public totalSymbolWeight;

    SlotsConfig[] private slotsConfigs;
    uint32 public currentConfigIndex;

    mapping(uint256 => PendingSpin) public pendingSpins;
    mapping(uint256 => SpinResult) public spinResults;

    uint8[3][NUM_PAYLINES] public paylines;

    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event SlotsConfigUpdated(
        uint32 indexed index,
        bool enabled,
        uint8 activeSymbolCount,
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
        uint256 totalPayout
    );

    /// @param refundAmount The amount transferred back to the player as a refund. Slots
    ///                     refunds `netStake` on VRF failure, so this is non-zero on the
    ///                     `handleRandomFailure` path.
    event SpinFailed(uint256 indexed requestId, address indexed player, bytes32 reason, uint256 refundAmount);

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(address handler, address provider, address eva, address authHub)
        PushVRFGame(eva, handler, provider, authHub, "MultiLineSlots", "1", address(0))
    {
        paylines[0] = [0, 1, 2];
        paylines[1] = [3, 4, 5];
        paylines[2] = [6, 7, 8];
        paylines[3] = [0, 4, 8];
        paylines[4] = [2, 4, 6];

        slotsConfigs.push(SlotsConfig({
            enabled: false,
            activeSymbolCount: 0,
            minWagerPerLine: 0,
            maxWagerPerLine: 0
        }));
        currentConfigIndex = 0;
    }

    // _paymentHandler() override provided by PushVRFGame.

    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN - CONFIG
    // ═══════════════════════════════════════════════════════════════════════

    function setSlotsConfig(SlotsConfig calldata config) external onlyOwner {
        if (config.maxWagerPerLine != 0 && config.maxWagerPerLine < config.minWagerPerLine) {
            revert WagerTooHigh(config.maxWagerPerLine, config.minWagerPerLine);
        }
        if (config.activeSymbolCount > MAX_SYMBOLS) revert InvalidSymbolConfig();

        slotsConfigs.push(config);
        currentConfigIndex = uint32(slotsConfigs.length - 1);

        emit SlotsConfigUpdated(
            currentConfigIndex,
            config.enabled,
            config.activeSymbolCount,
            config.minWagerPerLine,
            config.maxWagerPerLine
        );
    }

    function setSymbolConfig(uint8 symbolId, SymbolConfig calldata config) external onlyOwner {
        if (symbolId >= MAX_SYMBOLS) revert InvalidSymbolConfig();

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

    // ═══════════════════════════════════════════════════════════════════════
    //                              GAMEPLAY
    // ═══════════════════════════════════════════════════════════════════════

    function startSpin(
        uint256 wagerPerLine,
        uint8 paylineCount,
        address potentialReferrer
    ) external nonReentrant returns (uint256 requestId) {
        return _startSpinInternal(msg.sender, wagerPerLine, paylineCount, potentialReferrer);
    }

    function startSpinFor(
        address player,
        uint256 wagerPerLine,
        uint8 paylineCount,
        address potentialReferrer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOperator nonReentrant returns (uint256 requestId) {
        uint256 totalWager = wagerPerLine * paylineCount;
        bytes32 structHash = keccak256(
            abi.encode(
                START_SPIN_TYPEHASH,
                address(this),
                player,
                wagerPerLine,
                paylineCount,
                potentialReferrer,
                nonce,
                deadline
            )
        );
        _verifyAndConsume(player, address(this), totalWager, structHash, deadline, nonce, signature);
        return _startSpinInternal(player, wagerPerLine, paylineCount, potentialReferrer);
    }

    function _startSpinInternal(
        address bettor,
        uint256 wagerPerLine,
        uint8 paylineCount,
        address potentialReferrer
    ) internal returns (uint256 requestId) {
        uint32 cfgIdx = currentConfigIndex;
        SlotsConfig storage cfg = slotsConfigs[cfgIdx];

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

        (, address payoutTarget, , , , ) = paymentHandler.getGameConfig(address(this));
        if (payoutTarget != address(this)) revert PaymentHandlerMisconfigured();

        uint256 totalWager = wagerPerLine * paylineCount;

        uint256 netStake = _collectAndProcessBet(bettor, potentialReferrer, totalWager);
        require(netStake > 0, "net zero");

        uint256 maxPayout = _calculateMaxPayout(wagerPerLine, paylineCount);

        // Jackpot share is routed by PaymentHandler at bet entry; the game only locks for player payout.
        _lockExposure(maxPayout, 0);

        requestId = _requestRandomness();

        pendingSpins[requestId] = PendingSpin({
            player: bettor,
            wagerPerLine: wagerPerLine,
            activePaylines: paylineCount,
            totalWager: totalWager,
            netStake: netStake,
            maxPayout: maxPayout,
            configIndex: cfgIdx,
            exists: true
        });

        emit SpinStarted(
            requestId,
            bettor,
            paylineCount,
            wagerPerLine,
            totalWager,
            netStake,
            cfgIdx
        );
        // Standard envelope (IGameEvents).
        // data = abi.encode(wagerPerLine, paylineCount, netStake, maxPayout, configIndex)
        emit BetPlaced(
            requestId,
            bettor,
            totalWager,
            abi.encode(wagerPerLine, paylineCount, netStake, maxPayout, cfgIdx)
        );

        return requestId;
    }

    function fulfillRandomness(
        uint256 requestId,
        uint256 /*randomWord*/,
        uint256[] memory derivedValues
    ) external override onlyRandomProvider nonReentrant {
        if (derivedValues.length < GRID_SIZE) revert InvalidRandomResponse(derivedValues.length);

        PendingSpin memory spin = pendingSpins[requestId];
        if (!spin.exists) revert UnauthorizedCaller();

        _unlockExposure(spin.maxPayout, 0);
        delete pendingSpins[requestId];

        uint8[GRID_SIZE] memory grid = _generateGrid(derivedValues);

        (
            bool[NUM_PAYLINES] memory lineWins,
            uint8[NUM_PAYLINES] memory lineSymbol,
            uint16[NUM_PAYLINES] memory lineMultiplier,
            uint256 totalPayout
        ) = _evaluateAllPaylines(grid, spin.wagerPerLine, spin.activePaylines);

        spinResults[requestId] = SpinResult({
            grid: grid,
            lineWins: lineWins,
            lineSymbol: lineSymbol,
            lineMultiplier: lineMultiplier,
            totalPayout: totalPayout,
            timestamp: block.timestamp
        });

        if (totalPayout > 0) {
            _payPlayer(spin.player, totalPayout);
        }

        uint8 winningLineCount = 0;
        for (uint8 i = 0; i < NUM_PAYLINES; i++) {
            if (lineWins[i]) winningLineCount++;
        }

        emit SpinResolved(
            requestId,
            spin.player,
            grid,
            winningLineCount,
            totalPayout
        );
        // Standard envelope (IGameEvents). data = abi.encode(grid, winningLineCount)
        emit BetSettled(
            requestId,
            spin.player,
            totalPayout,
            abi.encode(grid, winningLineCount)
        );
    }

    function handleRandomFailure(
        uint256 requestId,
        bytes32 reason,
        bytes calldata /*details*/
    ) external override onlyRandomProvider nonReentrant {
        PendingSpin memory spin = pendingSpins[requestId];
        if (!spin.exists) return;

        _unlockExposure(spin.maxPayout, 0);
        delete pendingSpins[requestId];

        uint256 refundAmount = spin.netStake;
        _payPlayer(spin.player, refundAmount);

        emit SpinFailed(requestId, spin.player, reason, refundAmount);
        emit BetFailed(requestId, spin.player, reason);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              VIEWS
    // ═══════════════════════════════════════════════════════════════════════

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

    function previewSpin(uint256 wagerPerLine, uint8 paylineCount)
        external
        view
        returns (
            uint256 totalWager,
            uint256 maxPayout,
            uint256 estimatedNetStake
        )
    {
        totalWager = wagerPerLine * paylineCount;
        maxPayout = _calculateMaxPayout(wagerPerLine, paylineCount);

        uint16 netStakeBps = paymentHandler.getNetStakeBps(address(this));
        estimatedNetStake = totalWager * netStakeBps / BPS_DENOMINATOR;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              INTERNAL - GRID
    // ═══════════════════════════════════════════════════════════════════════

    function _generateGrid(uint256[] memory randomValues) internal view returns (uint8[GRID_SIZE] memory grid) {
        uint16 weightTotal = totalSymbolWeight;

        for (uint8 cell = 0; cell < GRID_SIZE; cell++) {
            uint256 roll = randomValues[cell] % weightTotal;
            grid[cell] = _randomToSymbol(roll);
        }
    }

    function _randomToSymbol(uint256 roll) internal view returns (uint8) {
        uint256 cumulative = 0;

        for (uint8 i = 0; i < MAX_SYMBOLS; i++) {
            if (!symbols[i].enabled) continue;

            cumulative += symbols[i].weightBps;
            if (roll < cumulative) {
                return i;
            }
        }

        return 0;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              INTERNAL - PAYLINES
    // ═══════════════════════════════════════════════════════════════════════

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
        for (uint8 i = 0; i < NUM_PAYLINES; i++) {
            lineSymbol[i] = NO_SYMBOL;
        }

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

    function _evaluateLine(
        uint8[GRID_SIZE] memory grid,
        uint8 lineIndex
    ) internal view returns (bool won, uint8 winSymbol, uint16 multiplier) {
        uint8[3] memory line = paylines[lineIndex];

        uint8 s0 = grid[line[0]];
        uint8 s1 = grid[line[1]];
        uint8 s2 = grid[line[2]];

        SymbolConfig memory cfg0 = symbols[s0];
        SymbolConfig memory cfg1 = symbols[s1];
        SymbolConfig memory cfg2 = symbols[s2];

        (bool is3Match, uint8 baseSymbol3) = _check3Match(s0, s1, s2, cfg0, cfg1, cfg2);
        if (is3Match) {
            return (true, baseSymbol3, symbols[baseSymbol3].threeMatchPayout);
        }

        (bool is2Match, uint8 baseSymbol2) = _check2Match(s0, s1, s2, cfg0, cfg1, cfg2);
        if (is2Match && symbols[baseSymbol2].twoMatchPayout > 0) {
            return (true, baseSymbol2, symbols[baseSymbol2].twoMatchPayout);
        }

        return (false, NO_SYMBOL, 0);
    }

    function _check3Match(
        uint8 s0, uint8 s1, uint8 s2,
        SymbolConfig memory cfg0,
        SymbolConfig memory cfg1,
        SymbolConfig memory cfg2
    ) internal pure returns (bool matches, uint8 baseSymbol) {
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

        if (wildCount == 3) {
            return (true, s0);
        }

        if (wildCount == 2) {
            return (true, nonWild1);
        }

        if (wildCount == 1) {
            if (nonWild1 == nonWild2) {
                return (true, nonWild1);
            }
            return (false, NO_SYMBOL);
        }

        if (s0 == s1 && s1 == s2) {
            return (true, s0);
        }

        return (false, NO_SYMBOL);
    }

    function _check2Match(
        uint8 s0, uint8 s1, uint8 s2,
        SymbolConfig memory cfg0,
        SymbolConfig memory cfg1,
        SymbolConfig memory cfg2
    ) internal pure returns (bool matches, uint8 baseSymbol) {
        uint8 wildCount = 0;
        if (cfg0.isWild) wildCount++;
        if (cfg1.isWild) wildCount++;
        if (cfg2.isWild) wildCount++;

        if (wildCount >= 2) return (false, NO_SYMBOL);

        if (wildCount == 1) {
            uint8 a;
            uint8 b;

            if (cfg0.isWild) {
                a = s1; b = s2;
            } else if (cfg1.isWild) {
                a = s0; b = s2;
            } else {
                a = s0; b = s1;
            }

            if (a != b) {
                return (false, NO_SYMBOL);
            }
            return (false, NO_SYMBOL);
        }

        if (s0 == s1 && s1 != s2) return (true, s0);
        if (s0 == s2 && s0 != s1) return (true, s0);
        if (s1 == s2 && s0 != s1) return (true, s1);

        return (false, NO_SYMBOL);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              INTERNAL - HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    function _calculateMaxPayout(uint256 wagerPerLine, uint8 paylineCount) internal view returns (uint256) {
        uint16 maxMultiplier = 0;
        for (uint8 i = 0; i < MAX_SYMBOLS; i++) {
            if (symbols[i].enabled) {
                if (symbols[i].threeMatchPayout > maxMultiplier) {
                    maxMultiplier = symbols[i].threeMatchPayout;
                }
            }
        }

        return Math.mulDiv(wagerPerLine * paylineCount, maxMultiplier, MULTIPLIER_SCALE);
    }

    function _requestRandomness() internal returns (uint256 requestId) {
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](GRID_SIZE);

        RandomDeriveLib.Range memory cellRange = RandomDeriveLib.Range({
            min: 0,
            max: uint128(totalSymbolWeight)
        });

        for (uint8 i = 0; i < GRID_SIZE; i++) {
            ranges[i] = cellRange;
        }

        requestId = randomProvider.requestRandomNumbers(ranges);
    }
}
