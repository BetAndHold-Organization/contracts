// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @title RandomDeriveLib
/// @notice Utility helpers to deterministically derive bounded random values from a
/// single 256-bit VRF word.
library RandomDeriveLib {
    /// @notice Configuration for a bounded random number.
    struct Range {
        uint128 min; // inclusive lower bound
        uint128 max; // exclusive upper bound
    }

    /// @notice Thrown when a requested range is invalid.
    error InvalidRange(uint256 index);

    /// @notice Derives bounded random numbers from a single 256-bit seed.
    /// @param seed The initial random seed (typically a VRF word).
    /// @param ranges The list of ranges to derive numbers for.
    /// @return values The derived numbers, each constrained to its range.
    /// @return lastSeed The final seed after processing all ranges (can be reused).
    function deriveBounded(
        uint256 seed,
        Range[] memory ranges
    ) internal pure returns (uint256[] memory values, uint256 lastSeed) {
        uint256 length = ranges.length;
        values = new uint256[](length);

        for (uint256 i = 0; i < length; i++) {
            Range memory range = ranges[i];
            uint256 minValue = uint256(range.min);
            uint256 maxValue = uint256(range.max);

            if (maxValue <= minValue) {
                revert InvalidRange(i);
            }

            uint256 span = maxValue - minValue; // guaranteed > 0
            uint256 boundedValue = (seed % span) + minValue;
            values[i] = boundedValue;

            // Derive the next seed for the following iteration.
            seed = uint256(keccak256(abi.encode(seed, i)));
        }

        lastSeed = seed;
    }

    /// @notice Derives a single bounded number and the next seed.
    /// @param seed The current random seed.
    /// @param minValue Inclusive lower bound for the derived value.
    /// @param maxValue Exclusive upper bound for the derived value.
    /// @param index Position of this derivation in the sequence (used for hashing and error reporting).
    /// @return value The derived random number within [minValue, maxValue).
    /// @return nextSeed The next seed to use for subsequent derivations.
    function deriveOnce(
        uint256 seed,
        uint128 minValue,
        uint128 maxValue,
        uint256 index
    ) internal pure returns (uint256 value, uint256 nextSeed) {
        uint256 min = uint256(minValue);
        uint256 max = uint256(maxValue);

        if (max <= min) {
            revert InvalidRange(index);
        }

        uint256 span = max - min;
        value = (seed % span) + min;
        nextSeed = uint256(keccak256(abi.encode(seed, index)));
    }

    /// @notice Derives a deterministic sequence of 256-bit words from an initial seed.
    /// @dev Useful when the consumer wants raw words instead of bounded numbers.
    /// @param seed The initial random seed.
    /// @param count How many additional words to derive.
    /// @return words The sequence of derived words (length == count).
    /// @return lastSeed The final seed after derivation.
    function deriveWordSequence(
        uint256 seed,
        uint256 count
    ) internal pure returns (uint256[] memory words, uint256 lastSeed) {
        words = new uint256[](count);

        for (uint256 i = 0; i < count; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            words[i] = seed;
        }

        lastSeed = seed;
    }
}

