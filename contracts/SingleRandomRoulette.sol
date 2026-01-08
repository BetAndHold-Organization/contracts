
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

interface IProgressiveJackpot {
    function addFunds(uint256 amount) external;

    function processJackpotEntry(address player, uint256 betAmount, uint256 roll) external returns (uint256 payout);

    function PROBABILITY_PRECISION() external view returns (uint256);

    function ensurePayable(address game, uint256 betAmount) external view;
}

contract SingleRandomRoulette is IRandomConsumer, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint8 internal constant MAX_ROLLS = 6;
    uint16 internal constant MULTIPLIER_SCALE = 100; // multiplier expressed in hundredths
    uint16 internal constant MIN_MULTIPLIER_HUNDREDTHS = 101; // 1.01x

    enum SpinResolution {
        Lose,
        Multiplier,
        Jackpot
    }

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

    struct TableConfig {
        bool enabled;
        uint16 replayBps;
        uint16 jackpotBps;
        uint16 jackpotContributionBps;
        uint16 minMultiplier;
        uint16 maxMultiplier;
        uint256 minWager;
        uint256 maxWager; // 0 = unlimited
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
        uint16 jackpotBps;
        uint16 replayBps;
        uint32 configIndex;
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
    }


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

    IPaymentHandlerMinimal public immutable paymentHandler;
    IRandomProviderMinimal public immutable randomProvider;
    IERC20 public immutable evaToken;

    IProgressiveJackpot public jackpot;
    TableConfig[] private tableConfigs;
    JackpotScalingConfig[] private scalingConfigs;
    uint32 public currentConfigIndex;

    uint256 public lockedExposure;
    uint256 private jackpotRollCap;

    mapping(uint256 => PendingSpin) public pendingSpins;

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
        uint32 configIndex
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

    // --- Admin ---

    function setTableConfig(TableConfig calldata config) external onlyOwner {
        if (config.replayBps + config.jackpotBps > BPS_DENOMINATOR) revert ProbabilityOverflow();
        if (config.jackpotContributionBps > BPS_DENOMINATOR) revert ProbabilityOverflow();
        if (config.minMultiplier < MIN_MULTIPLIER_HUNDREDTHS) revert InvalidMultiplier(config.minMultiplier);
        if (config.maxMultiplier != 0 && config.maxMultiplier < config.minMultiplier) {
            revert InvalidMultiplier(config.maxMultiplier);
        }
        if (config.maxWager != 0 && config.maxWager < config.minWager) revert WagerTooHigh(config.maxWager, config.minWager);
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

    function getJackpotScalingConfig() external view returns (JackpotScalingConfig memory) {
        return scalingConfigs[currentConfigIndex];
    }

    function getJackpotScalingConfig(uint256 index) external view returns (JackpotScalingConfig memory) {
        require(index < scalingConfigs.length, "config index");
        return scalingConfigs[index];
    }

    function getTableConfig() external view returns (TableConfig memory) {
        return tableConfigs[currentConfigIndex];
    }

    function getTableConfig(uint256 index) external view returns (TableConfig memory) {
        require(index < tableConfigs.length, "config index");
        return tableConfigs[index];
    }

    function setJackpot(address newJackpot) external onlyOwner {
        address oldJackpot = address(jackpot);
        if (oldJackpot != address(0)) {
            evaToken.safeApprove(oldJackpot, 0);
        }

        if (newJackpot == address(0)) {
            jackpot = IProgressiveJackpot(address(0));
            jackpotRollCap = 0;
            emit JackpotUpdated(address(0), 0);
            return;
        }

        IProgressiveJackpot candidate = IProgressiveJackpot(newJackpot);
        uint256 precision = candidate.PROBABILITY_PRECISION();
        if (precision == 0 || precision > type(uint128).max) revert ProbabilityOverflow();

        jackpot = candidate;
        jackpotRollCap = precision;

        evaToken.safeApprove(newJackpot, type(uint256).max);

        emit JackpotUpdated(newJackpot, precision);
    }

    // --- Core gameplay ---

    function startSpin(uint256 wager, uint256 multiplierHundredths, address potentialReferrer)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        
        if (!tableConfigs[currentConfigIndex].enabled) revert RouletteDisabled();

        if (multiplierHundredths < tableConfigs[currentConfigIndex].minMultiplier) revert InvalidMultiplier(multiplierHundredths);
        if (tableConfigs[currentConfigIndex].maxMultiplier != 0 && multiplierHundredths > tableConfigs[currentConfigIndex].maxMultiplier) revert InvalidMultiplier(multiplierHundredths);
        if (tableConfigs[currentConfigIndex].minWager > 0 && wager < tableConfigs[currentConfigIndex].minWager) revert WagerTooLow(wager, tableConfigs[currentConfigIndex].minWager);
        if (tableConfigs[currentConfigIndex].maxWager > 0 && wager > tableConfigs[currentConfigIndex].maxWager) revert WagerTooHigh(wager, tableConfigs[currentConfigIndex].maxWager);

        uint16 jackpotBps = _computeJackpotProbability(currentConfigIndex, tableConfigs[currentConfigIndex].jackpotBps, wager);

    uint16 multiplierBps;
        {
            (, address payoutTarget, , uint16 houseEdgeBps, uint16 referralBps) = paymentHandler.getGameConfig(address(this));
            if (payoutTarget != address(this)) revert PaymentHandlerMisconfigured();

            (multiplierBps, ) = _deriveMultiplierProbability(
                multiplierHundredths,
                tableConfigs[currentConfigIndex].replayBps,
                jackpotBps,
                _calculateEffectiveEdge(houseEdgeBps, referralBps, tableConfigs[currentConfigIndex].jackpotContributionBps)
            );
        }


        uint256 netStake = paymentHandler.processDirectBetFromGame(msg.sender, potentialReferrer, wager);
        require(netStake > 0, "net zero");

        uint256 jackpotCap = jackpotRollCap;
        if ((jackpotBps > 0 || tableConfigs[currentConfigIndex].jackpotContributionBps > 0) && jackpotCap == 0) revert JackpotNotConfigured();

        _ensurePayability(tableConfigs[currentConfigIndex], wager, multiplierHundredths, netStake, jackpotBps);

        SpinParams memory params;
        params.wager = wager;
        params.netStake = netStake;
        params.maxPayout = _computeMaxPayout(wager, multiplierHundredths);
        params.jackpotContribution = Math.mulDiv(netStake, tableConfigs[currentConfigIndex].jackpotContributionBps, BPS_DENOMINATOR);
        params.multiplierHundredths = uint24(multiplierHundredths);
        params.multiplierBps = multiplierBps;
        params.jackpotBps = jackpotBps;
        params.replayBps = tableConfigs[currentConfigIndex].replayBps;
        params.configIndex = currentConfigIndex;

        _lockExposure(params.maxPayout, params.jackpotContribution);

        requestId = _requestSpinRandomness(uint128(jackpotCap == 0 ? BPS_DENOMINATOR : jackpotCap));

        _storePendingSpin(requestId, msg.sender, params);

        emit SpinStarted(
            requestId,
            msg.sender,
            wager,
            netStake,
            multiplierHundredths,
            params.maxPayout,
            params.jackpotContribution,
            currentConfigIndex
        );

        return requestId;
    }

    function fulfillRandomness(uint256 requestId, uint256 /*randomWord*/, uint256[] memory derivedValues)
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

        if (outcome == SpinResolution.Jackpot) {
            uint256 jackpotRoll = derivedValues[MAX_ROLLS];
            if (jackpotRollCap == 0 || jackpotRoll >= jackpotRollCap) revert InvalidRandomSlice(jackpotRoll);
            _depositToJackpot(spin.jackpotContribution);
            jackpotPayout = jackpot.processJackpotEntry(spin.player, spin.wager, jackpotRoll);
        } else {
            if (outcome == SpinResolution.Multiplier) {
                evaToken.safeTransfer(spin.player, spin.maxPayout);
            }
            _depositToJackpot(spin.jackpotContribution);
        }

        uint256 payout = outcome == SpinResolution.Multiplier ? spin.maxPayout : 0;

        emit SpinResolved(requestId, spin.player, uint8(outcome), payout, spinsConsumed, jackpotPayout);
    }

    function handleRandomFailure(uint256 requestId, bytes32 reason, bytes calldata /*details*/ )
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

    // --- Views ---

    function availableLiquidity() external view returns (uint256) {
        uint256 balance = evaToken.balanceOf(address(this));
        if (balance <= lockedExposure) return 0;
        return balance - lockedExposure;
    }

function previewSpin(uint256 wager, uint256 multiplierHundredths, uint32 configIndex)
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

    jackpotProbability = _computeJackpotProbability(index, tableConfigs[index].jackpotBps, wager);
    replayProbability = tableConfigs[index].replayBps;
    
    // Get fees and calculate effective edge inline
    (, , , uint16 houseEdgeBps, uint16 referralBps) = paymentHandler.getGameConfig(address(this));
    
    (multiplierProbability, loseProbability) = _deriveMultiplierProbability(
        multiplierHundredths,
        replayProbability,
        jackpotProbability,
        _calculateEffectiveEdge(houseEdgeBps, referralBps, tableConfigs[index].jackpotContributionBps)
    );
    
    // Calculate outputs inline
    maxPayout = (wager * multiplierHundredths) / MULTIPLIER_SCALE;
    jackpotContribution = ((wager * (BPS_DENOMINATOR - houseEdgeBps - referralBps) / BPS_DENOMINATOR) 
        * tableConfigs[index].jackpotContributionBps) / BPS_DENOMINATOR;
}

    // --- Internal helpers ---

    function _depositToJackpot(uint256 amount) internal {
        if (amount == 0 || address(jackpot) == address(0)) {
            return;
        }
        jackpot.addFunds(amount);
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
            //revert ProbabilityOverflow();
            jackpotBps = BPS_DENOMINATOR - multiplierBps - replayBps - 100;
        }

        loseBps = uint16(BPS_DENOMINATOR - multiplierBps - replayBps - jackpotBps);
    }

    function _resolveSpin(
        PendingSpin memory spin,
        TableConfig memory config,
        uint16 jackpotBps,
        uint256[] memory derivedValues
    ) internal pure returns (SpinResolution outcome, uint8 spinsConsumed) {
        uint256 multiplierThreshold = spin.multiplierBps;
        uint256 replayThreshold = multiplierThreshold + config.replayBps;
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

    function _ensurePayability(
        TableConfig storage cfg,
        uint256 betAmount,
        uint256 multiplierHundredths,
        uint256 netStake,
        uint16 jackpotBps
    ) internal view {
        uint16 effectiveMultiplier = cfg.maxMultiplier == 0 ? uint16(multiplierHundredths) : cfg.maxMultiplier;
        uint256 requiredPayout = Math.mulDiv(betAmount, effectiveMultiplier, MULTIPLIER_SCALE);

        uint256 projectedExposure = lockedExposure + requiredPayout;
        uint256 balance = evaToken.balanceOf(address(this));
        if (balance < projectedExposure) revert LiquidityShortfall(balance, projectedExposure);

        if (jackpotBps > 0 || cfg.jackpotContributionBps > 0) {
            if (address(jackpot) == address(0)) revert JackpotNotConfigured();
            jackpot.ensurePayable(address(this), netStake);
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

/// @notice Calculates effective edge that accounts for all fee layers
/// @dev Converts house + referral + jackpot contribution into a single "effective edge"
/// @param houseEdgeBps House fee in basis points (e.g., 500 = 5%)
/// @param referralBps Referral fee in basis points (e.g., 200 = 2%)
/// @param jackpotContributionBps Jackpot contribution in basis points of net stake (e.g., 350 = 3.5%)
/// @return effectiveEdgeBps The combined effective edge in basis points
function _calculateEffectiveEdge(
    uint16 houseEdgeBps,
    uint16 referralBps,
    uint16 jackpotContributionBps
) internal pure returns (uint16 effectiveEdgeBps) {
    // Step 1: Calculate net stake rate (what % of wager goes to roulette)
    // netStakeRate = 100% - houseEdge - referral
    // Example: 10000 - 500 - 200 = 9300 (93%)
    uint256 netStakeRate = BPS_DENOMINATOR - houseEdgeBps - referralBps;
    
    // Step 2: Calculate pool funding rate (what % of wager the pool actually keeps)
    // poolFundingRate = netStakeRate × (1 - jackpotContribution)
    // Example: 9300 × (10000 - 350) / 10000 = 9300 × 9650 / 10000 = 8974 (89.74%)
    uint256 poolFundingRate = (netStakeRate * (BPS_DENOMINATOR - jackpotContributionBps)) / BPS_DENOMINATOR;
    
    // Step 3: Convert to effective edge
    // effectiveEdge = 100% - poolFundingRate
    // Example: 10000 - 8974 = 1026 (10.26%)
    effectiveEdgeBps = uint16(BPS_DENOMINATOR - poolFundingRate);
    
    return effectiveEdgeBps;
}

    ///FOR TESTS ONLY
    function emergencyWithdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "to");
        uint256 bal = evaToken.balanceOf(address(this));
        uint256 amt = amount == 0 ? bal : amount;
        require(amt <= bal, "insufficient");
        evaToken.safeTransfer(to, amt);
    }
}

