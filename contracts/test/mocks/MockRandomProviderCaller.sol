// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {RandomDeriveLib} from "../../libraries/RandomDeriveLib.sol";
import {IRandomConsumer} from "../../interfaces/core/IRandomConsumer.sol";
import {IRandomProviderMinimal} from "../../interfaces/core/IRandomProviderMinimal.sol";

contract MockRandomProviderCaller is IRandomProviderMinimal {
    uint256 private nextRequestId = 1;
    mapping(uint256 => address) private consumers;

    function requestRandomNumber(uint256) external override returns (uint256 requestId) {
        requestId = nextRequestId++;
        consumers[requestId] = msg.sender;
    }

    function requestRandomNumbers(RandomDeriveLib.Range[] calldata) external override returns (uint256 requestId) {
        requestId = nextRequestId++;
        consumers[requestId] = msg.sender;
    }

    function getRequestStatus(uint256) external pure override returns (uint8) {
        return 1; // Pending — no actual tracking needed for this caller mock
    }

    function FAILURE_TIMEOUT() external pure override returns (bytes32) { return bytes32(0); }
    function FAILURE_CONSUMER_REVERT() external pure override returns (bytes32) { return bytes32(0); }
    function FAILURE_CONSUMER_ERROR() external pure override returns (bytes32) { return bytes32(0); }

    function fulfillWith(uint256 requestId, uint256[] calldata derivedValues) external {
        IRandomConsumer(consumers[requestId]).fulfillRandomness(requestId, 0, derivedValues);
    }
}


