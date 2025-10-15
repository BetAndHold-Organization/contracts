// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

library JackpotScalingLib {
    using Math for uint256;

    uint256 internal constant ONE = 1e18;

    enum ScalingFunction {
        Linear,
        Quadratic,
        Logarithmic,
        Exponential
    }

    struct ScalingConfig {
        bool enabled;
        uint16 minJackpotBps;
        uint16 maxJackpotBps;
        uint256 minJackpotWager;
        uint256 maxJackpotWager;
        ScalingFunction functionId;
        bytes extraData;
    }

    error ScalingDisabled();
    error InvalidScalingBounds();
    error InvalidScalingRange();
    error InvalidScalingFunction();

    function computeProbability(ScalingConfig memory config, uint256 wager) internal pure returns (uint16) {
        if (!config.enabled) revert ScalingDisabled();
        if (config.maxJackpotBps < config.minJackpotBps) revert InvalidScalingRange();
        if (config.maxJackpotBps == 0) return 0;

        if (wager < config.minJackpotWager) {
            return 0;
        }

        if (config.maxJackpotWager <= config.minJackpotWager) revert InvalidScalingBounds();

        if (wager >= config.maxJackpotWager) {
            return config.maxJackpotBps;
        }

        uint256 span = config.maxJackpotWager - config.minJackpotWager;
        uint256 position = ((wager - config.minJackpotWager) * ONE) / span;
        uint256 scaled = applyCurve(config.functionId, position);
        uint256 base = uint256(config.minJackpotBps);
        uint256 delta = uint256(config.maxJackpotBps) - base;

        return uint16(base + (delta * scaled) / ONE);
    }

    function applyCurve(ScalingFunction functionId, uint256 normalized) internal pure returns (uint256) {
        return _applyCurve(uint8(functionId), normalized);
    }

    function applyCurveUnsafe(uint8 functionId, uint256 normalized) internal pure returns (uint256) {
        return _applyCurve(functionId, normalized);
    }

    function _applyCurve(uint8 functionId, uint256 normalized) private pure returns (uint256) {
        if (normalized == 0) return 0;
        if (normalized >= ONE) return ONE;

        if (functionId == uint8(ScalingFunction.Linear)) {
            return normalized;
        }

        if (functionId == uint8(ScalingFunction.Quadratic)) {
            return (normalized * normalized) / ONE;
        }

        if (functionId == uint8(ScalingFunction.Logarithmic)) {
            // Approximate a logarithmic-style curve using square root for concave growth
            return Math.sqrt(normalized * ONE);
        }

        if (functionId == uint8(ScalingFunction.Exponential)) {
            uint256 square = (normalized * normalized) / ONE;
            return (square * normalized) / ONE;
        }

        revert InvalidScalingFunction();
    }
}
