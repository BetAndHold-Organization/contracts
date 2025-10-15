// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "forge-std/Test.sol";
import {JackpotScalingLib} from "contracts/libraries/JackpotScalingLib.sol";

contract JackpotScalingLibTest is Test {
    using JackpotScalingLib for JackpotScalingLib.ScalingConfig;

    JackpotScalingLib.ScalingConfig private config;

    function setUp() public {
        config.enabled = true;
        config.minJackpotBps = 10; // 0.10%
        config.maxJackpotBps = 500; // 5%
        config.minJackpotWager = 1 ether;
        config.maxJackpotWager = 100 ether;
    }

    function testLinearScaling() public {
        config.functionId = JackpotScalingLib.ScalingFunction.Linear;

        assertEq(config.computeProbability(0.5 ether), 0);
        assertEq(config.computeProbability(1 ether), config.minJackpotBps);
        assertEq(config.computeProbability(50 ether), _interpolate(0.5 ether));
        assertEq(config.computeProbability(100 ether), config.maxJackpotBps);
        assertEq(config.computeProbability(120 ether), config.maxJackpotBps);
    }

    function testQuadraticScaling() public {
        config.functionId = JackpotScalingLib.ScalingFunction.Quadratic;

        assertEq(config.computeProbability(1 ether), config.minJackpotBps);
        assertApproxEqAbs(config.computeProbability(50 ether), _interpolateQuadratic(0.5 ether), 1);
        assertEq(config.computeProbability(100 ether), config.maxJackpotBps);
    }

    function testLogarithmicScaling() public {
        config.functionId = JackpotScalingLib.ScalingFunction.Logarithmic;

        assertEq(config.computeProbability(1 ether), config.minJackpotBps);
        assertApproxEqAbs(config.computeProbability(50 ether), _interpolateLog(0.5 ether), 2);
        assertEq(config.computeProbability(100 ether), config.maxJackpotBps);
    }

    function testExponentialScaling() public {
        config.functionId = JackpotScalingLib.ScalingFunction.Exponential;

        assertEq(config.computeProbability(1 ether), config.minJackpotBps);
        assertApproxEqAbs(config.computeProbability(50 ether), _interpolateExponential(0.5 ether), 2);
        assertEq(config.computeProbability(100 ether), config.maxJackpotBps);
    }

    function testDisabledScalingReverts() public {
        config.enabled = false;
        vm.expectRevert(JackpotScalingLib.ScalingDisabled.selector);
        config.computeProbability(1 ether);
    }

    function testInvalidRangeReverts() public {
        config.maxJackpotBps = 5;
        vm.expectRevert(JackpotScalingLib.InvalidScalingRange.selector);
        config.computeProbability(5 ether);
    }

    function testInvalidBoundsReverts() public {
        config.maxJackpotWager = 0;
        vm.expectRevert(JackpotScalingLib.InvalidScalingBounds.selector);
        config.computeProbability(5 ether);
    }

    function testZeroMaxReturnsZero() public {
        config.maxJackpotBps = 0;
        assertEq(config.computeProbability(10 ether), 0);
    }

    function testBelowMinimumReturnsZero() public view {
        JackpotScalingLib.ScalingConfig memory localConfig = config;
        localConfig; // silence unused warning
    }

    function _normalized(uint256 wager) private view returns (uint256) {
        return ((wager - config.minJackpotWager) * JackpotScalingLib.ONE) /
            (config.maxJackpotWager - config.minJackpotWager);
    }

    function _interpolate(uint256 wager) private view returns (uint16) {
        uint256 normalized = _normalized(wager);
        return uint16(uint256(config.minJackpotBps) + (uint256(config.maxJackpotBps - config.minJackpotBps) * normalized) / JackpotScalingLib.ONE);
    }

    function _interpolateQuadratic(uint256 wager) private view returns (uint16) {
        uint256 normalized = _normalized(wager);
        uint256 scaled = (normalized * normalized) / JackpotScalingLib.ONE;
        return uint16(uint256(config.minJackpotBps) + (uint256(config.maxJackpotBps - config.minJackpotBps) * scaled) / JackpotScalingLib.ONE);
    }

    function _interpolateLog(uint256 wager) private view returns (uint16) {
        uint256 normalized = _normalized(wager);
        uint256 scaled = _sqrt(normalized * JackpotScalingLib.ONE);
        return uint16(uint256(config.minJackpotBps) + (uint256(config.maxJackpotBps - config.minJackpotBps) * scaled) / JackpotScalingLib.ONE);
    }

    function _interpolateExponential(uint256 wager) private view returns (uint16) {
        uint256 normalized = _normalized(wager);
        uint256 scaled = (normalized * normalized) / JackpotScalingLib.ONE;
        scaled = (scaled * normalized) / JackpotScalingLib.ONE;
        return uint16(uint256(config.minJackpotBps) + (uint256(config.maxJackpotBps - config.minJackpotBps) * scaled) / JackpotScalingLib.ONE);
    }

    function _sqrt(uint256 x) private pure returns (uint256 result) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        result = x;
        while (z < result) {
            result = z;
            z = (x / z + z) / 2;
        }
    }
}
