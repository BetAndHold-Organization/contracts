// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {RandomDeriveLib} from "../libraries/RandomDeriveLib.sol";

/// @dev Minimal harness used by the Hardhat test suite to exercise RandomDeriveLib via viem.
contract RandomDeriveLibHarness {
    using RandomDeriveLib for uint256;

    function callDerive(
        uint256 seed,
        RandomDeriveLib.Range[] calldata ranges
    ) external pure returns (uint256[] memory values, uint256 nextSeed) {
        RandomDeriveLib.Range[] memory copy = new RandomDeriveLib.Range[](ranges.length);
        for (uint256 i = 0; i < ranges.length; i++) {
            copy[i] = ranges[i];
        }
        return RandomDeriveLib.deriveBounded(seed, copy);
    }

    function callDeriveOnce(
        uint256 seed,
        uint128 minValue,
        uint128 maxValue,
        uint256 index
    ) external pure returns (uint256 value, uint256 nextSeed) {
        return RandomDeriveLib.deriveOnce(seed, minValue, maxValue, index);
    }

    function callDeriveWords(uint256 seed, uint256 count)
        external
        pure
        returns (uint256[] memory words, uint256 lastSeed)
    {
        return RandomDeriveLib.deriveWordSequence(seed, count);
    }
}


