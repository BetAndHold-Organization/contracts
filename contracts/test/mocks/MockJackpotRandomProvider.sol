// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IRandomConsumer} from "../../interfaces/core/IRandomConsumer.sol";

contract MockJackpotRandomProvider {
    uint256 public nextRequestId = 1;

    struct PendingRequest {
        IRandomConsumer consumer;
        uint256 maxNumber;
    }

    mapping(uint256 => PendingRequest) public pendingRequests;

    function requestRandomNumber(uint256 maxNumber) external returns (uint256 requestId) {
        requestId = nextRequestId;
        nextRequestId++;
        pendingRequests[requestId] = PendingRequest({
            consumer: IRandomConsumer(msg.sender),
            maxNumber: maxNumber
        });
    }

    function resetCounter(uint256 newValue) external {
        nextRequestId = newValue;
    }

    function fulfill(uint256 requestId, uint256 roll) external {
        PendingRequest memory req = pendingRequests[requestId];
        require(address(req.consumer) != address(0), "Unknown request");
        delete pendingRequests[requestId];

        uint256[] memory values = new uint256[](1);
        values[0] = roll;
        req.consumer.fulfillRandomness(requestId, roll, values);
    }

    function fail(uint256 requestId, bytes32 reason, bytes calldata details) external {
        PendingRequest memory req = pendingRequests[requestId];
        require(address(req.consumer) != address(0), "Unknown request");
        delete pendingRequests[requestId];

        req.consumer.handleRandomFailure(requestId, reason, details);
    }
}

