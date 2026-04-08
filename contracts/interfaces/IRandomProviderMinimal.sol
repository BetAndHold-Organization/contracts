// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {RandomDeriveLib} from "../libraries/RandomDeriveLib.sol";

interface IRandomProviderMinimal {
    function requestRandomNumbers(RandomDeriveLib.Range[] calldata ranges) external returns (uint256 requestId);
}
