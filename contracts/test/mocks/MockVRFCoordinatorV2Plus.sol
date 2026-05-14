// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IVRFCoordinatorV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

/// @dev Minimal mock to satisfy RandomProvider testing needs.
contract MockVRFCoordinatorV2Plus is IVRFCoordinatorV2Plus {
    uint256 public nextRequestId = 1;

    event RandomnessRequested(uint256 indexed requestId, address indexed sender);

    function setMockRequestId(uint256 newId) external {
        nextRequestId = newId;
    }

    function requestRandomWords(
        VRFV2PlusClient.RandomWordsRequest calldata
    ) external override returns (uint256 requestId) {
        requestId = nextRequestId++;
        emit RandomnessRequested(requestId, msg.sender);
    }

    function fulfill(
        address consumer,
        uint256 requestId,
        uint256[] memory words
    ) external {
        (bool ok, bytes memory data) = consumer.call(
            abi.encodeWithSignature(
                "rawFulfillRandomWords(uint256,uint256[])",
                requestId,
                words
            )
        );
        if (!ok) {
            assembly {
                revert(add(data, 0x20), mload(data))
            }
        }
    }

    // --- IVRFSubscriptionV2Plus stubs ---
    function addConsumer(uint256, address) external pure override {}

    function removeConsumer(uint256, address) external pure override {}

    function cancelSubscription(uint256, address) external pure override {}

    function acceptSubscriptionOwnerTransfer(uint256) external pure override {}

    function requestSubscriptionOwnerTransfer(uint256, address) external pure override {}

    function createSubscription() external pure override returns (uint256) {
        return 1;
    }

    function getSubscription(uint256)
        external
        pure
        override
        returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address owner, address[] memory consumers)
    {
        address[] memory empty;
        return (0, 0, 0, address(0), empty);
    }

    function pendingRequestExists(uint256) external pure override returns (bool) {
        return false;
    }

    function getActiveSubscriptionIds(uint256, uint256) external pure override returns (uint256[] memory) {
        return new uint256[](0);
    }

    function fundSubscriptionWithNative(uint256) external payable override {}
}

