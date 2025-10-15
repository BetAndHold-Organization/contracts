// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IProgressiveJackpot} from "../SingleRandomRoulette.sol";

/// @dev Minimal jackpot mock returning a configurable probability precision.
contract MockJackpotPrecision is IProgressiveJackpot {
    uint256 private immutable _precision;

    constructor(uint256 precision) {
        _precision = precision;
    }

    function addFunds(uint256) external override {}

    function processJackpotEntry(address, uint256, uint256)
        external
        pure
        override
        returns (uint256)
    {
        return 0;
    }

    function PROBABILITY_PRECISION() external view override returns (uint256) {
        return _precision;
    }

    function ensurePayable(address, uint256) external view override {}
}


