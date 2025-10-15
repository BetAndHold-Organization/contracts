// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {RandomDeriveLib} from "../libraries/RandomDeriveLib.sol";
import {IRandomConsumer} from "../interfaces/IRandomConsumer.sol";
import {IRandomProviderMinimal} from "../SingleRandomRoulette.sol";

contract MockRandomProviderCaller is IRandomProviderMinimal {
    uint256 private nextRequestId = 1;
    mapping(uint256 => address) private consumers;

    function requestRandomNumbers(RandomDeriveLib.Range[] calldata) external override returns (uint256 requestId) {
        requestId = nextRequestId++;
        consumers[requestId] = msg.sender;
    }

    function fulfillWith(uint256 requestId, uint256[] calldata derivedValues) external {
        IRandomConsumer(consumers[requestId]).fulfillRandomness(requestId, 0, derivedValues);
    }
}


