// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import {IRandomConsumer} from "./interfaces/IRandomConsumer.sol";
import {RandomDeriveLib} from "./libraries/RandomDeriveLib.sol";
import {JackpotScalingLib} from "./libraries/JackpotScalingLib.sol";

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

interface IProgressiveJackpotV2 {
    function addFunds(uint256 amount) external;
    function processJackpotEntry(address player, uint256 betAmount, uint256 roll) external returns (uint256 payout);
    function PROBABILITY_PRECISION() external view returns (uint256);
    function ensurePayable(address game, uint256 betAmount) external view;
}

/**
 * @title SingleRandomRouletteV2
 * @notice Roulette game with optional jackpot participation
 * @dev When jackpot is disabled per-spin, jackpot probability transfers to replay
 */
contract SingleRandomRouletteV2 is IRandomConsumer, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint8 internal constant MAX_ROLLS = 6;
    uint16 internal constant MULTIPLIER_SCALE = 100;
    uint16 internal constant MIN_MULTIPLIER_HUNDREDTHS = 101; // 1.01x

    enum SpinResolution {
        Lose,
        Multiplier,
        Jackpot
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Structs
    // ─────────────────────────────────────────────────────────────────────────

    struct TableConfig {
        bool enabled;
        uint16 replayBps;           // Base replay probability
        uint16 jackpotBps;          // Jackpot probability (transfers to replay if jackpot disabled)
        uint16 jackpotContributionBps;
        uint16 minMultiplier;
        uint16 maxMultiplier;
        uint256 minWager;
        uint256 maxWager;
    }

    struct JackpotScalingConfig {
        bool enabled;
        uint16 minJackpotBps;
        uint16 maxJackpotBps;
        uint256 minJackpotWager;
        uint256 maxJackpotWager;
        JackpotScalingLib.ScalingFunction functionId;
        bytes extraData;
    }

    struct PendingSpin {
        address player;
        uint256 wager;
        uint256 netStake;
        uint256 maxPayout;
        uint256 jackpotContribution;
        uint24 multiplierHundredths;
        uint16 multiplierBps;
        uint16 jackpotBps;          // 0 if player opted out of jackpot
        uint16 replayBps;           // Includes transferred jackpot probability if opted out
        uint32 configIndex;
        bool participatingInJackpot;
        bool exists;
    }

    struct SpinParams {
        uint256 wager;
        uint256 netStake;
        uint256 maxPayout;
        uint256 jackpotContribution;
        uint24 multiplierHundredths;
        uint16 multiplierBps;
        uint16 replayBps;
        uint16 jackpotBps;
        uint32 configIndex;
        bool participatingInJackpot;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error UnauthorizedCaller();
    error RouletteDisabled();
    error InvalidMultiplier(uint256 requested);
    error WagerTooLow(uint256 provided, uint256 required);
    error WagerTooHigh(uint256 provided, uint256 allowed);
    error LiquidityShortfall(uint256 available, uint256 required);
    error ProbabilityOverflow();
    error JackpotNotConfigured();
    error InvalidRandomResponse(uint256 length);
    error InvalidRandomSlice(uint256 value);
    error PaymentHandlerMisconfigured();

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    IPaymentHandlerMinimal public immutable paymentHandler;
    IRandomProviderMinimal public immutable randomProvider;
    IERC20 public immutable evaToken;

    IProgressiveJackpotV2 public jackpot;
    TableConfig[] private tableConfigs;
    JackpotScalingConfig[] private scalingConfigs;
    uint32 public currentConfigIndex;

    uint256 public lockedExposure;
    uint256 private jackpotRollCap;

    mapping(uint256 => PendingSpin) public pendingSpins;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event TableConfigUpdated(
        uint32 index,
        bool enabled,
        uint16 replayBps,
        uint16 jackpotBps,
        uint16 jackpotContributionBps,
        uint16 minMultiplier,
        uint16 maxMultiplier,
        uint256 minWager,
        uint256 maxWager
    );

    event JackpotScalingUpdated(
        uint32 index,
        bool enabled,
        uint16 minJackpotBps,
        uint16 maxJackpotBps,
        uint256 minJackpotWager,
        uint256 maxJackpotWager,
        JackpotScalingLib.ScalingFunction functionId
    );

    event JackpotUpdated(address indexed jackpot, uint256 probabilityPrecision);

    event SpinStarted(
        uint256 indexed requestId,
        address indexed player,
        uint256 wager,
        uint256 netStake,
        uint256 multiplierHundredths,
        uint256 maxPayout,
        uint256 jackpotContribution,
        uint32 configIndex,
        bool participatingInJackpot
    );

    event SpinResolved(
        uint256 indexed requestId,
        address indexed player,
        uint8 outcome,
        uint256 payout,
        uint8 spinsConsumed,
        uint256 jackpotPayout
    );

    event SpinFailed(uint256 indexed requestId, address indexed player, bytes32 reason);

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    constructor(address handler, address provider, address eva) {
        if (handler == address(0) || provider == address(0) || eva == address(0)) {
            revert PaymentHandlerMisconfigured();
        }

        paymentHandler = IPaymentHandlerMinimal(handler);
        randomProvider = IRandomProviderMinimal(provider);
        evaToken = IERC20(eva);

        tableConfigs.push(
            TableConfig({
                enabled: false,
                replayBps: 0,
                jackpotBps: 0,
                jackpotContributionBps: 0,
                minMultiplier: MIN_MULTIPLIER_HUNDREDTHS,
                maxMultiplier: MIN_MULTIPLIER_HUNDREDTHS,
                minWager: 0,
                maxWager: 0
            })
        );

        scalingConfigs.push(
            JackpotScalingConfig({
                enabled: false,
                minJackpotBps: 0,
                maxJackpotBps: 0,
                minJackpotWager: 0,
                maxJackpotWager: 0,
                functionId: JackpotScalingLib.ScalingFunction.Linear,
                extraData: ""
            })
        );

        currentConfigIndex = 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin - Table Configuration
    // ─────────────────────────────────────────────────────────────────────────

    function setTableConfig(TableConfig calldata config) external onlyOwner {
        if (config.replayBps + config.jackpotBps > BPS_DENOMINATOR) revert ProbabilityOverflow();
        if (config.jackpotContributionBps > BPS_DENOMINATOR) revert ProbabilityOverflow();
        if (config.minMultiplier < MIN_MULTIPLIER_HUNDREDTHS) revert InvalidMultiplier(config.minMultiplier);
        if (config.maxMultiplier != 0 && config.maxMultiplier < config.minMultiplier) {
            revert InvalidMultiplier(config.maxMultiplier);
        }
        if (config.maxWager != 0 && config.maxWager < config.minWager) {
            revert WagerTooHigh(config.maxWager, config.minWager);
        }
        if (config.jackpotBps > 0 || config.jackpotContributionBps > 0) {
            if (address(jackpot) == address(0)) revert JackpotNotConfigured();
        }

        tableConfigs.push(config);
        scalingConfigs.push(scalingConfigs[currentConfigIndex]);
        currentConfigIndex = uint32(tableConfigs.length - 1);

        emit TableConfigUpdated(
            currentConfigIndex,
            config.enabled,
            config.replayBps,
            config.jackpotBps,
            config.jackpotContributionBps,
            config.minMultiplier,
            config.maxMultiplier,
            config.minWager,
            config.maxWager
        );
    }

    function setJackpotScalingConfig(JackpotScalingConfig calldata config) external onlyOwner {
        uint32 index = currentConfigIndex;
        JackpotScalingConfig storage stored = scalingConfigs[index];

        if (config.enabled) {
            if (config.maxJackpotBps > BPS_DENOMINATOR) revert ProbabilityOverflow();
            if (config.maxJackpotBps < config.minJackpotBps) revert ProbabilityOverflow();
            if (config.maxJackpotWager <= config.minJackpotWager) revert ProbabilityOverflow();
        }

        stored.enabled = config.enabled;
        stored.minJackpotBps = config.minJackpotBps;
        stored.maxJackpotBps = config.maxJackpotBps;
        stored.minJackpotWager = config.minJackpotWager;
        stored.maxJackpotWager = config.maxJackpotWager;
        stored.functionId = config.functionId;
        stored.extraData = config.extraData;

        emit JackpotScalingUpdated(
            index,
            config.enabled,
            config.minJackpotBps,
            config.maxJackpotBps,
            config.minJackpotWager,
            config.maxJackpotWager,
            config.functionId
        );
    }

    function setJackpot(address newJackpot) external onlyOwner {
        address oldJackpot = address(jackpot);
        if (oldJackpot != address(0)) {
            evaToken.safeApprove(oldJackpot, 0);
        }

        if (newJackpot == address(0)) {
            jackpot = IProgressiveJackpotV2(address(0));
            jackpotRollCap = 0;
            emit JackpotUpdated(address(0), 0);
            return;
        }

        IProgressiveJackpotV2 candidate = IProgressiveJackpotV2(newJackpot);
        uint256 precision = candidate.PROBABILITY_PRECISION();
        if (precision == 0 || precision > type(uint128).max) revert ProbabilityOverflow();

        jackpot = candidate;
        jackpotRollCap = precision;

        evaToken.safeApprove(newJackpot, type(uint256).max);

        emit JackpotUpdated(newJackpot, precision);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View Functions
    // ─────────────────────────────────────────────────────────────────────────

    function getTableConfig() external view returns (TableConfig memory) {
        return tableConfigs[currentConfigIndex];
    }

    function getTableConfig(uint256 index) external view returns (TableConfig memory) {
        require(index < tableConfigs.length, "config index");
        return tableConfigs[index];
    }

    function getJackpotScalingConfig() external view returns (JackpotScalingConfig memory) {
        return scalingConfigs[currentConfigIndex];
    }

    function getJackpotScalingConfig(uint256 index) external view returns (JackpotScalingConfig memory) {
        require(index < scalingConfigs.length, "config index");
        return scalingConfigs[index];
    }

    function availableLiquidity() external view returns (uint256) {
        uint256 balance = evaToken.balanceOf(address(this));
        if (balance <= lockedExposure) return 0;
        return balance - lockedExposure;
    }

    /**
     * @notice Preview spin probabilities with jackpot participation choice
     * @param wager The wager amount
     * @param multiplierHundredths The multiplier (e.g., 200 = 2x)
     * @param configIndex Config index (type(uint32).max for current)
     * @param participateInJackpot Whether to include jackpot probability
     */
    function previewSpin(
        uint256 wager,
        uint256 multiplierHundredths,
        uint32 configIndex,
        bool participateInJackpot
    )
        external
        view
        returns (
            uint16 multiplierProbability,
            uint16 replayProbability,
            uint16 jackpotProbability,
            uint16 loseProbability,
            uint256 maxPayout,
            uint256 jackpotContribution
        )
    {
        uint32 index = configIndex == type(uint32).max ? currentConfigIndex : configIndex;
        require(index < tableConfigs.length, "config index");

        TableConfig memory cfg = tableConfigs[index];

        // Compute probabilities using helper
        (multiplierProbability, jackpotProbability, replayProbability) = _computeSpinProbabilitiesForIndex(
            wager, multiplierHundredths, index, cfg, participateInJackpot
        );

        // Compute lose probability
        loseProbability = BPS_DENOMINATOR - multiplierProbability - replayProbability - jackpotProbability;

        // Compute contribution and payout
        jackpotContribution = _previewJackpotContribution(wager, cfg.jackpotContributionBps);
        maxPayout = (wager * multiplierHundredths) / MULTIPLIER_SCALE;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Core Gameplay
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Start a spin with optional jackpot participation
     * @param wager The wager amount in EVA
     * @param multiplierHundredths The desired multiplier (e.g., 200 = 2x)
     * @param potentialReferrer Referrer address (or zero)
     * @param participateInJackpot If true, contribute to and participate in jackpot
     * @return requestId The VRF request ID
     */
    function startSpin(
        uint256 wager,
        uint256 multiplierHundredths,
        address potentialReferrer,
        bool participateInJackpot
    )
        external
        nonReentrant
        returns (uint256 requestId)
    {
        SpinParams memory params;
        params.configIndex = currentConfigIndex;
        params.participatingInJackpot = participateInJackpot;
        
        // Validate and compute probabilities in scoped block
        {
            TableConfig memory cfg = tableConfigs[currentConfigIndex];
            
            if (!cfg.enabled) revert RouletteDisabled();
            if (multiplierHundredths < cfg.minMultiplier) revert InvalidMultiplier(multiplierHundredths);
            if (cfg.maxMultiplier != 0 && multiplierHundredths > cfg.maxMultiplier) {
                revert InvalidMultiplier(multiplierHundredths);
            }
            if (cfg.minWager > 0 && wager < cfg.minWager) revert WagerTooLow(wager, cfg.minWager);
            if (cfg.maxWager > 0 && wager > cfg.maxWager) revert WagerTooHigh(wager, cfg.maxWager);

            // Check jackpot configured if needed
            if (cfg.jackpotContributionBps > 0 && address(jackpot) == address(0)) {
                revert JackpotNotConfigured();
            }
            if (participateInJackpot && cfg.jackpotBps > 0 && jackpotRollCap == 0) {
                revert JackpotNotConfigured();
            }

            // Compute probabilities
            (params.multiplierBps, params.jackpotBps, params.replayBps) = _computeSpinProbabilities(
                wager, multiplierHundredths, cfg, participateInJackpot
            );
        }

        // Process payment
        params.netStake = paymentHandler.processDirectBetFromGame(msg.sender, potentialReferrer, wager);
        require(params.netStake > 0, "net zero");

        // Compute derived values
        params.wager = wager;
        params.multiplierHundredths = uint24(multiplierHundredths);
        params.maxPayout = _computeMaxPayout(wager, multiplierHundredths);
        params.jackpotContribution = _computeJackpotContribution(params.netStake, tableConfigs[currentConfigIndex].jackpotContributionBps);

        // Ensure payability
        _ensurePayabilitySimple(wager, multiplierHundredths, params.netStake, params.jackpotBps, participateInJackpot);

        // Lock exposure
        _lockExposure(params.maxPayout, params.jackpotContribution);

        // Request randomness and store
        requestId = _requestSpinRandomness(uint128(participateInJackpot && jackpotRollCap > 0 ? jackpotRollCap : BPS_DENOMINATOR));
        _storePendingSpin(requestId, msg.sender, params);

        emit SpinStarted(
            requestId,
            msg.sender,
            wager,
            params.netStake,
            multiplierHundredths,
            params.maxPayout,
            params.jackpotContribution,
            currentConfigIndex,
            participateInJackpot
        );
    }

    function fulfillRandomness(
        uint256 requestId,
        uint256 /*randomWord*/,
        uint256[] memory derivedValues
    )
        external
        override
        nonReentrant
    {
        if (msg.sender != address(randomProvider)) revert UnauthorizedCaller();
        if (derivedValues.length < MAX_ROLLS + 1) revert InvalidRandomResponse(derivedValues.length);

        PendingSpin memory spin = pendingSpins[requestId];
        if (!spin.exists) revert UnauthorizedCaller();

        _unlockExposure(spin.maxPayout, spin.jackpotContribution);
        delete pendingSpins[requestId];

        TableConfig memory config = tableConfigs[spin.configIndex];

        (SpinResolution outcome, uint8 spinsConsumed) = _resolveSpin(spin, config, spin.jackpotBps, derivedValues);

        uint256 jackpotPayout;

        // Always deposit jackpot contribution (regardless of participation)
        _depositToJackpot(spin.jackpotContribution);

        if (outcome == SpinResolution.Jackpot && spin.participatingInJackpot) {
            // Player participating: process jackpot entry
            uint256 jackpotRoll = derivedValues[MAX_ROLLS];
            if (jackpotRollCap == 0 || jackpotRoll >= jackpotRollCap) revert InvalidRandomSlice(jackpotRoll);
            jackpotPayout = jackpot.processJackpotEntry(spin.player, spin.wager, jackpotRoll);
        } else if (outcome == SpinResolution.Multiplier) {
            // Multiplier win: pay out
            evaToken.safeTransfer(spin.player, spin.maxPayout);
        }
        // Note: If Jackpot outcome but not participating, it's already converted to replay
        // so this case shouldn't happen (jackpotBps = 0 when not participating)

        uint256 payout = outcome == SpinResolution.Multiplier ? spin.maxPayout : 0;

        emit SpinResolved(requestId, spin.player, uint8(outcome), payout, spinsConsumed, jackpotPayout);
    }

    function handleRandomFailure(
        uint256 requestId,
        bytes32 reason,
        bytes calldata /*details*/
    )
        external
        override
        nonReentrant
    {
        if (msg.sender != address(randomProvider)) revert UnauthorizedCaller();

        PendingSpin memory spin = pendingSpins[requestId];
        if (!spin.exists) {
            return;
        }

        _unlockExposure(spin.maxPayout, spin.jackpotContribution);
        delete pendingSpins[requestId];

        emit SpinFailed(requestId, spin.player, reason);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal Helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _toScalingConfig(JackpotScalingConfig storage config)
        internal
        view
        returns (JackpotScalingLib.ScalingConfig memory)
    {
        bytes memory extra = config.extraData.length > 0 ? abi.encodePacked(config.extraData) : bytes("");
        return JackpotScalingLib.ScalingConfig({
            enabled: config.enabled,
            minJackpotBps: config.minJackpotBps,
            maxJackpotBps: config.maxJackpotBps,
            minJackpotWager: config.minJackpotWager,
            maxJackpotWager: config.maxJackpotWager,
            functionId: config.functionId,
            extraData: extra
        });
    }

    function _computeJackpotProbability(uint32 configIndex, uint16 staticBps, uint256 wager)
        internal
        view
        returns (uint16)
    {
        JackpotScalingConfig storage scalingStorage = scalingConfigs[configIndex];
        if (!scalingStorage.enabled) {
            return staticBps;
        }
        return JackpotScalingLib.computeProbability(_toScalingConfig(scalingStorage), wager);
    }

    function _depositToJackpot(uint256 amount) internal {
        if (amount == 0 || address(jackpot) == address(0)) {
            return;
        }
        jackpot.addFunds(amount);
    }

    function _computeSpinProbabilities(
        uint256 wager,
        uint256 multiplierHundredths,
        TableConfig memory cfg,
        bool participateInJackpot
    ) internal view returns (uint16 multiplierBps, uint16 jackpotBps, uint16 replayBps) {
        return _computeSpinProbabilitiesForIndex(wager, multiplierHundredths, currentConfigIndex, cfg, participateInJackpot);
    }

    function _computeSpinProbabilitiesForIndex(
        uint256 wager,
        uint256 multiplierHundredths,
        uint32 index,
        TableConfig memory cfg,
        bool participateInJackpot
    ) internal view returns (uint16 multiplierBps, uint16 jackpotBps, uint16 replayBps) {
        // Get fees
        (, , , uint16 houseEdgeBps, uint16 referralBps) = paymentHandler.getGameConfig(address(this));
        
        // Base jackpot probability
        uint16 baseJackpotBps = _computeJackpotProbability(index, cfg.jackpotBps, wager);
        
        // Apply participation choice
        if (participateInJackpot) {
            jackpotBps = baseJackpotBps;
            replayBps = cfg.replayBps;
        } else {
            jackpotBps = 0;
            replayBps = cfg.replayBps + baseJackpotBps;
        }
        
        // Effective edge always includes contribution
        uint16 effectiveEdge = _calculateEffectiveEdge(houseEdgeBps, referralBps, cfg.jackpotContributionBps);
        
        (multiplierBps, ) = _deriveMultiplierProbability(multiplierHundredths, replayBps, jackpotBps, effectiveEdge);
    }

    function _previewJackpotContribution(uint256 wager, uint16 contributionBps) internal view returns (uint256) {
        if (contributionBps == 0) return 0;
        (, , , uint16 houseEdgeBps, uint16 referralBps) = paymentHandler.getGameConfig(address(this));
        uint256 netStake = (wager * (BPS_DENOMINATOR - houseEdgeBps - referralBps)) / BPS_DENOMINATOR;
        return (netStake * contributionBps) / BPS_DENOMINATOR;
    }

    function _computeJackpotContribution(uint256 netStake, uint16 contributionBps) internal pure returns (uint256) {
        if (contributionBps == 0) return 0;
        return Math.mulDiv(netStake, contributionBps, BPS_DENOMINATOR);
    }

    function _ensurePayabilitySimple(
        uint256 betAmount,
        uint256 multiplierHundredths,
        uint256 netStake,
        uint16 jackpotBps,
        bool participateInJackpot
    ) internal view {
        TableConfig memory cfg = tableConfigs[currentConfigIndex];
        uint16 effectiveMultiplier = cfg.maxMultiplier == 0 ? uint16(multiplierHundredths) : cfg.maxMultiplier;
        uint256 requiredPayout = Math.mulDiv(betAmount, effectiveMultiplier, MULTIPLIER_SCALE);

        uint256 projectedExposure = lockedExposure + requiredPayout;
        uint256 balance = evaToken.balanceOf(address(this));
        if (balance < projectedExposure) revert LiquidityShortfall(balance, projectedExposure);

        if (cfg.jackpotContributionBps > 0 && address(jackpot) == address(0)) {
            revert JackpotNotConfigured();
        }
        if (participateInJackpot && jackpotBps > 0) {
            jackpot.ensurePayable(address(this), netStake);
        }
    }

    function _deriveMultiplierProbability(
        uint256 multiplierHundredths,
        uint16 replayBps,
        uint16 jackpotBps,
        uint16 houseEdgeBps
    ) internal pure returns (uint16 multiplierBps, uint16 loseBps) {
        uint256 baseRtp = BPS_DENOMINATOR - houseEdgeBps;
        uint256 chainMultiplierBps = _chainMultiplier(replayBps);

        uint256 adjustedRtp = Math.mulDiv(baseRtp, BPS_DENOMINATOR, chainMultiplierBps);

        multiplierBps = uint16(Math.min(BPS_DENOMINATOR, (adjustedRtp * MULTIPLIER_SCALE) / multiplierHundredths));

        if (uint256(multiplierBps) + replayBps + jackpotBps > BPS_DENOMINATOR) {
            jackpotBps = BPS_DENOMINATOR - multiplierBps - replayBps - 100;
        }

        loseBps = uint16(BPS_DENOMINATOR - multiplierBps - replayBps - jackpotBps);
    }

    function _resolveSpin(
        PendingSpin memory spin,
        TableConfig memory /*config*/,
        uint16 jackpotBps,
        uint256[] memory derivedValues
    ) internal pure returns (SpinResolution outcome, uint8 spinsConsumed) {
        uint256 multiplierThreshold = spin.multiplierBps;
        uint256 replayThreshold = multiplierThreshold + spin.replayBps;
        uint256 jackpotThreshold = replayThreshold + jackpotBps;

        for (uint8 i = 0; i < MAX_ROLLS; i++) {
            uint256 roll = derivedValues[i];
            if (roll >= BPS_DENOMINATOR) revert InvalidRandomSlice(roll);

            spinsConsumed = i + 1;

            if (roll < multiplierThreshold) {
                return (SpinResolution.Multiplier, spinsConsumed);
            }

            if (roll < replayThreshold) {
                if (i == MAX_ROLLS - 1) {
                    return (SpinResolution.Lose, spinsConsumed);
                }
                continue;
            }

            if (roll < jackpotThreshold) {
                return (SpinResolution.Jackpot, spinsConsumed);
            }

            return (SpinResolution.Lose, spinsConsumed);
        }

        return (SpinResolution.Lose, MAX_ROLLS);
    }

    function _buildRanges(uint128 jackpotCap)
        internal
        pure
        returns (RandomDeriveLib.Range[] memory ranges)
    {
        ranges = new RandomDeriveLib.Range[](MAX_ROLLS + 1);
        RandomDeriveLib.Range memory base = RandomDeriveLib.Range({min: 0, max: uint128(BPS_DENOMINATOR)});
        for (uint256 i = 0; i < MAX_ROLLS; i++) {
            ranges[i] = base;
        }
        ranges[MAX_ROLLS] = RandomDeriveLib.Range({min: 0, max: jackpotCap});
    }

    function _requestSpinRandomness(uint128 jackpotCap) internal returns (uint256 requestId) {
        RandomDeriveLib.Range[] memory ranges = _buildRanges(jackpotCap);
        requestId = randomProvider.requestRandomNumbers(ranges);
    }

    function _storePendingSpin(uint256 requestId, address player, SpinParams memory params) internal {
        PendingSpin storage stored = pendingSpins[requestId];
        stored.player = player;
        stored.wager = params.wager;
        stored.netStake = params.netStake;
        stored.maxPayout = params.maxPayout;
        stored.jackpotContribution = params.jackpotContribution;
        stored.multiplierHundredths = params.multiplierHundredths;
        stored.multiplierBps = params.multiplierBps;
        stored.jackpotBps = params.jackpotBps;
        stored.replayBps = params.replayBps;
        stored.configIndex = params.configIndex;
        stored.participatingInJackpot = params.participatingInJackpot;
        stored.exists = true;
    }

    function _chainMultiplier(uint16 replayBps) internal pure returns (uint256 acc) {
        acc = BPS_DENOMINATOR;
        uint256 term = BPS_DENOMINATOR;
        for (uint8 i = 0; i < MAX_ROLLS - 1; i++) {
            term = (term * replayBps) / BPS_DENOMINATOR;
            if (term == 0) break;
            acc += term;
        }
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

    function _computeMaxPayout(uint256 wager, uint256 multiplierHundredths) internal pure returns (uint256) {
        return Math.mulDiv(wager, multiplierHundredths, MULTIPLIER_SCALE);
    }

    /**
     * @notice Calculate effective edge accounting for all fee layers
     * @param houseEdgeBps House fee in basis points
     * @param referralBps Referral fee in basis points
     * @param jackpotContributionBps Jackpot contribution in basis points of net stake
     * @return effectiveEdgeBps The combined effective edge
     */
    function _calculateEffectiveEdge(
        uint16 houseEdgeBps,
        uint16 referralBps,
        uint16 jackpotContributionBps
    ) internal pure returns (uint16 effectiveEdgeBps) {
        uint256 netStakeRate = BPS_DENOMINATOR - houseEdgeBps - referralBps;
        uint256 poolFundingRate = (netStakeRate * (BPS_DENOMINATOR - jackpotContributionBps)) / BPS_DENOMINATOR;
        effectiveEdgeBps = uint16(BPS_DENOMINATOR - poolFundingRate);
        return effectiveEdgeBps;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Emergency
    // ─────────────────────────────────────────────────────────────────────────

    function emergencyWithdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "to");
        uint256 bal = evaToken.balanceOf(address(this));
        uint256 amt = amount == 0 ? bal : amount;
        require(amt <= bal, "insufficient");
        evaToken.safeTransfer(to, amt);
    }
}

