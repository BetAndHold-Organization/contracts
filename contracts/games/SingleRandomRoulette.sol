// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import {PushVRFGame} from "./base/PushVRFGame.sol";
import {RandomDeriveLib} from "../libraries/RandomDeriveLib.sol";
import {JackpotScalingLib} from "../libraries/JackpotScalingLib.sol";

/**
 * @title SingleRandomRoulette
 * @notice Roulette game with optional jackpot participation on the PushVRFGame canonical base.
 * @dev    When jackpot is disabled per-spin, jackpot probability transfers to replay.
 */
contract SingleRandomRoulette is PushVRFGame {

    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint8 internal constant MAX_ROLLS = 6;
    uint16 internal constant MULTIPLIER_SCALE = 100;
    uint16 internal constant MIN_MULTIPLIER_HUNDREDTHS = 101; // 1.01x

    /// @notice EIP-712 typehash for startSpinFor meta-transactions.
    bytes32 public constant START_SPIN_TYPEHASH = keccak256(
        "StartSpin(address game,address player,uint256 wager,uint256 multiplierHundredths,address potentialReferrer,bool participateInJackpot,uint256 nonce,uint256 deadline)"
    );

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
        uint16 replayBps;
        uint16 jackpotBps;
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
        uint24 multiplierHundredths;
        uint16 multiplierBps;
        uint16 jackpotBps;
        uint16 replayBps;
        uint32 configIndex;
        bool participatingInJackpot;
        bool exists;
    }

    struct SpinParams {
        uint256 wager;
        uint256 netStake;
        uint256 maxPayout;
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

    error RouletteDisabled();
    error InvalidMultiplier(uint256 requested);
    error WagerTooLow(uint256 provided, uint256 required);
    error WagerTooHigh(uint256 provided, uint256 allowed);
    error InvalidRandomResponse(uint256 length);
    error InvalidRandomSlice(uint256 value);
    error ProbabilityOverflow();

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    TableConfig[] private tableConfigs;
    JackpotScalingConfig[] private scalingConfigs;
    uint32 public currentConfigIndex;

    mapping(uint256 => PendingSpin) public pendingSpins;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event TableConfigUpdated(
        uint32 index,
        bool enabled,
        uint16 replayBps,
        uint16 jackpotBps,
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

    event SpinStarted(
        uint256 indexed requestId,
        address indexed player,
        uint256 wager,
        uint256 netStake,
        uint256 multiplierHundredths,
        uint256 maxPayout,
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

    constructor(address handler, address provider, address eva, address authHub)
        PushVRFGame(eva, handler, provider, authHub, "SingleRandomRoulette", "1", address(0))
    {
        tableConfigs.push(
            TableConfig({
                enabled: false,
                replayBps: 0,
                jackpotBps: 0,
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

    // _paymentHandler() override provided by PushVRFGame.

    // ─────────────────────────────────────────────────────────────────────────
    // Admin - Table Configuration
    // ─────────────────────────────────────────────────────────────────────────

    function setTableConfig(TableConfig calldata config) external onlyOwner {
        if (config.replayBps + config.jackpotBps > BPS_DENOMINATOR) revert ProbabilityOverflow();
        if (config.minMultiplier < MIN_MULTIPLIER_HUNDREDTHS) revert InvalidMultiplier(config.minMultiplier);
        if (config.maxMultiplier != 0 && config.maxMultiplier < config.minMultiplier) {
            revert InvalidMultiplier(config.maxMultiplier);
        }
        if (config.maxWager != 0 && config.maxWager < config.minWager) {
            revert WagerTooHigh(config.maxWager, config.minWager);
        }
        if (config.jackpotBps > 0 && address(_activeJackpot()) == address(0)) {
            revert JackpotNotConfigured();
        }

        tableConfigs.push(config);
        scalingConfigs.push(scalingConfigs[currentConfigIndex]);
        currentConfigIndex = uint32(tableConfigs.length - 1);

        emit TableConfigUpdated(
            currentConfigIndex,
            config.enabled,
            config.replayBps,
            config.jackpotBps,
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
            uint256 maxPayout
        )
    {
        uint32 index = configIndex == type(uint32).max ? currentConfigIndex : configIndex;
        require(index < tableConfigs.length, "config index");

        TableConfig memory cfg = tableConfigs[index];

        (multiplierProbability, jackpotProbability, replayProbability) = _computeSpinProbabilitiesForIndex(
            wager, multiplierHundredths, index, cfg, participateInJackpot
        );

        loseProbability = BPS_DENOMINATOR - multiplierProbability - replayProbability - jackpotProbability;
        maxPayout = (wager * multiplierHundredths) / MULTIPLIER_SCALE;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Core Gameplay
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Player calls directly to spin the current table.
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
        return _startSpinInternal(msg.sender, wager, multiplierHundredths, potentialReferrer, participateInJackpot);
    }

    /// @notice Operator-relayed entry. Verifies the player's session-key signature, then runs the
    ///         identical internal flow as startSpin so events and state changes are uniform.
    function startSpinFor(
        address player,
        uint256 wager,
        uint256 multiplierHundredths,
        address potentialReferrer,
        bool participateInJackpot,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOperator nonReentrant returns (uint256 requestId) {
        bytes32 structHash = keccak256(abi.encode(
            START_SPIN_TYPEHASH,
            address(this),
            player,
            wager,
            multiplierHundredths,
            potentialReferrer,
            participateInJackpot,
            nonce,
            deadline
        ));
        _verifyAndConsume(player, address(this), wager, structHash, deadline, nonce, signature);
        return _startSpinInternal(player, wager, multiplierHundredths, potentialReferrer, participateInJackpot);
    }

    /// @dev Shared spin logic used by both startSpin and startSpinFor.
    function _startSpinInternal(
        address bettor,
        uint256 wager,
        uint256 multiplierHundredths,
        address potentialReferrer,
        bool participateInJackpot
    ) internal returns (uint256 requestId) {
        SpinParams memory params;
        params.configIndex = currentConfigIndex;
        params.participatingInJackpot = participateInJackpot;

        {
            TableConfig memory cfg = tableConfigs[currentConfigIndex];

            if (!cfg.enabled) revert RouletteDisabled();
            if (multiplierHundredths < cfg.minMultiplier) revert InvalidMultiplier(multiplierHundredths);
            if (cfg.maxMultiplier != 0 && multiplierHundredths > cfg.maxMultiplier) {
                revert InvalidMultiplier(multiplierHundredths);
            }
            if (cfg.minWager > 0 && wager < cfg.minWager) revert WagerTooLow(wager, cfg.minWager);
            if (cfg.maxWager > 0 && wager > cfg.maxWager) revert WagerTooHigh(wager, cfg.maxWager);

            if (participateInJackpot && cfg.jackpotBps > 0 && _jackpotRollCap() == 0) {
                revert JackpotNotConfigured();
            }

            (params.multiplierBps, params.jackpotBps, params.replayBps) = _computeSpinProbabilities(
                wager, multiplierHundredths, cfg, participateInJackpot
            );
        }

        params.netStake = _collectAndProcessBet(bettor, potentialReferrer, wager);
        require(params.netStake > 0, "net zero");

        params.wager = wager;
        params.multiplierHundredths = uint24(multiplierHundredths);
        params.maxPayout = _computeMaxPayout(wager, multiplierHundredths);

        _ensurePayabilitySimple(wager, multiplierHundredths, params.netStake, params.jackpotBps, participateInJackpot);

        // Jackpot share is routed by PaymentHandler at bet entry, so we only lock the maxPayout
        // exposure to the player. Pass 0 for the jackpot-contribution arg.
        _lockExposure(params.maxPayout, 0);

        uint256 rollCap = _jackpotRollCap();
        requestId = _requestSpinRandomness(uint128(participateInJackpot && rollCap > 0 ? rollCap : BPS_DENOMINATOR));
        _storePendingSpin(requestId, bettor, params);

        emit SpinStarted(
            requestId,
            bettor,
            wager,
            params.netStake,
            multiplierHundredths,
            params.maxPayout,
            currentConfigIndex,
            participateInJackpot
        );
        // Standard envelope (IGameEvents).
        // data = abi.encode(netStake, multiplierHundredths, maxPayout, configIndex, participateInJackpot)
        emit BetPlaced(
            requestId,
            bettor,
            wager,
            abi.encode(params.netStake, multiplierHundredths, params.maxPayout, currentConfigIndex, participateInJackpot)
        );
    }

    function fulfillRandomness(
        uint256 requestId,
        uint256 /*randomWord*/,
        uint256[] memory derivedValues
    )
        external
        override
        onlyRandomProvider
        nonReentrant
    {
        if (derivedValues.length < MAX_ROLLS + 1) revert InvalidRandomResponse(derivedValues.length);

        PendingSpin memory spin = pendingSpins[requestId];
        if (!spin.exists) revert UnauthorizedCaller();

        _unlockExposure(spin.maxPayout, 0);
        delete pendingSpins[requestId];

        TableConfig memory config = tableConfigs[spin.configIndex];

        (SpinResolution outcome, uint8 spinsConsumed) = _resolveSpin(spin, config, spin.jackpotBps, derivedValues);

        uint256 jackpotPayout;

        if (outcome == SpinResolution.Jackpot && spin.participatingInJackpot) {
            uint256 jackpotRoll = derivedValues[MAX_ROLLS];
            uint256 cap = _jackpotRollCap();
            if (cap == 0 || jackpotRoll >= cap) revert InvalidRandomSlice(jackpotRoll);
            jackpotPayout = _enterJackpot(spin.player, spin.wager, jackpotRoll);
        } else if (outcome == SpinResolution.Multiplier) {
            _payPlayer(spin.player, spin.maxPayout);
        }

        uint256 payout = outcome == SpinResolution.Multiplier ? spin.maxPayout : 0;

        emit SpinResolved(requestId, spin.player, uint8(outcome), payout, spinsConsumed, jackpotPayout);
        // Standard envelope (IGameEvents). Total payout = on-chain payout + jackpot share.
        // data = abi.encode(outcome, spinsConsumed, jackpotPayout)
        emit BetSettled(
            requestId,
            spin.player,
            payout + jackpotPayout,
            abi.encode(uint8(outcome), spinsConsumed, jackpotPayout)
        );
    }

    function handleRandomFailure(
        uint256 requestId,
        bytes32 reason,
        bytes calldata /*details*/
    )
        external
        override
        onlyRandomProvider
        nonReentrant
    {
        PendingSpin memory spin = pendingSpins[requestId];
        if (!spin.exists) {
            return;
        }

        _unlockExposure(spin.maxPayout, 0);
        delete pendingSpins[requestId];

        emit SpinFailed(requestId, spin.player, reason);
        emit BetFailed(requestId, spin.player, reason);
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
        (, , , uint16 houseEdgeBps, uint16 referralBps, uint16 platformJackpotBps) = paymentHandler.getGameConfig(address(this));

        uint16 baseJackpotBps = _computeJackpotProbability(index, cfg.jackpotBps, wager);

        if (participateInJackpot) {
            jackpotBps = baseJackpotBps;
            replayBps = cfg.replayBps;
        } else {
            jackpotBps = 0;
            replayBps = cfg.replayBps + baseJackpotBps;
        }

        uint16 effectiveEdge = _calculateEffectiveEdge(houseEdgeBps, referralBps, platformJackpotBps);

        (multiplierBps, ) = _deriveMultiplierProbability(multiplierHundredths, replayBps, jackpotBps, effectiveEdge);
    }

    function _ensurePayabilitySimple(
        uint256 betAmount,
        uint256 multiplierHundredths,
        uint256 netStake,
        uint16 _jackpotBps,
        bool participateInJackpot
    ) internal view {
        TableConfig memory cfg = tableConfigs[currentConfigIndex];
        uint16 effectiveMultiplier = cfg.maxMultiplier == 0 ? uint16(multiplierHundredths) : cfg.maxMultiplier;
        uint256 requiredPayout = Math.mulDiv(betAmount, effectiveMultiplier, MULTIPLIER_SCALE);

        uint256 projectedExposure = lockedExposure + requiredPayout;
        uint256 balance = evaToken.balanceOf(address(this));
        if (balance < projectedExposure) revert LiquidityShortfall(balance, projectedExposure);

        if (participateInJackpot && _jackpotBps > 0) {
            _ensureJackpotPayable(netStake);
        }
    }

    function _deriveMultiplierProbability(
        uint256 multiplierHundredths,
        uint16 replayBps,
        uint16 _jackpotBps,
        uint16 houseEdgeBps
    ) internal pure returns (uint16 multiplierBps, uint16 loseBps) {
        uint256 baseRtp = BPS_DENOMINATOR - houseEdgeBps;
        uint256 chainMultiplierBps = _chainMultiplier(replayBps);

        uint256 adjustedRtp = Math.mulDiv(baseRtp, BPS_DENOMINATOR, chainMultiplierBps);

        multiplierBps = uint16(Math.min(BPS_DENOMINATOR, (adjustedRtp * MULTIPLIER_SCALE) / multiplierHundredths));

        if (uint256(multiplierBps) + replayBps + _jackpotBps > BPS_DENOMINATOR) {
            _jackpotBps = BPS_DENOMINATOR - multiplierBps - replayBps - 100;
        }

        loseBps = uint16(BPS_DENOMINATOR - multiplierBps - replayBps - _jackpotBps);
    }

    function _resolveSpin(
        PendingSpin memory spin,
        TableConfig memory /*config*/,
        uint16 _jackpotBps,
        uint256[] memory derivedValues
    ) internal pure returns (SpinResolution outcome, uint8 spinsConsumed) {
        uint256 multiplierThreshold = spin.multiplierBps;
        uint256 replayThreshold = multiplierThreshold + spin.replayBps;
        uint256 jackpotThreshold = replayThreshold + _jackpotBps;

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

    function _computeMaxPayout(uint256 wager, uint256 multiplierHundredths) internal pure returns (uint256) {
        return Math.mulDiv(wager, multiplierHundredths, MULTIPLIER_SCALE);
    }

    /// @dev Computes the player-perceived edge: the sum of all PaymentHandler-routed deductions
    ///      (house + referral + platform jackpot). Equivalent to paymentHandler.getTotalDeductionBps,
    ///      but takes the inputs as args so callers that already have them avoid an extra view call.
    function _calculateEffectiveEdge(
        uint16 houseEdgeBps,
        uint16 referralBps,
        uint16 platformJackpotBps
    ) internal pure returns (uint16 effectiveEdgeBps) {
        return houseEdgeBps + referralBps + platformJackpotBps;
    }
}
