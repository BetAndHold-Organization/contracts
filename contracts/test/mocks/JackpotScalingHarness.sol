// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {JackpotScalingLib} from "../../libraries/JackpotScalingLib.sol";

contract JackpotScalingHarness {
    using JackpotScalingLib for JackpotScalingLib.ScalingConfig;

    JackpotScalingLib.ScalingConfig private config;

    function setConfig(
        bool enabled,
        uint16 minJackpotBps,
        uint16 maxJackpotBps,
        uint256 minJackpotWager,
        uint256 maxJackpotWager,
        JackpotScalingLib.ScalingFunction functionId
    ) external {
        config.enabled = enabled;
        config.minJackpotBps = minJackpotBps;
        config.maxJackpotBps = maxJackpotBps;
        config.minJackpotWager = minJackpotWager;
        config.maxJackpotWager = maxJackpotWager;
        config.functionId = functionId;
    }

    function setExtraData(bytes calldata extraData) external {
        config.extraData = extraData;
    }

    function computeProbability(uint256 wager) external view returns (uint16) {
        return config.computeProbability(wager);
    }

    function getConfig() external view returns (JackpotScalingLib.ScalingConfig memory) {
        return config;
    }

    function callApplyCurve(uint8 functionId, uint256 normalized) external pure returns (uint256) {
        return JackpotScalingLib.applyCurveUnsafe(functionId, normalized);
    }
}
