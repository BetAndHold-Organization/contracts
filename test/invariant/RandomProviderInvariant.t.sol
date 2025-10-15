// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";
import {RandomProvider} from "contracts/RandomProvider.sol";
import {MockVRFCoordinatorV2Plus} from "contracts/mocks/MockVRFCoordinatorV2Plus.sol";
import {MockRandomConsumer, IRandomRequestor} from "contracts/mocks/MockRandomConsumer.sol";
import {RandomDeriveLib} from "contracts/libraries/RandomDeriveLib.sol";

contract RandomProviderHandler is Test {
    using RandomDeriveLib for uint256;

    RandomProvider public provider;
    MockVRFCoordinatorV2Plus public coordinator;
    MockRandomConsumer public consumerA;
    MockRandomConsumer public consumerB;

    address[] public consumers;
    uint256 public lastRequestId;

    constructor(RandomProvider _provider, MockVRFCoordinatorV2Plus _coordinator, address owner) {
        provider = _provider;
        coordinator = _coordinator;

        consumerA = new MockRandomConsumer(address(provider));
        consumerB = new MockRandomConsumer(address(provider));

        consumers.push(address(consumerA));
        consumers.push(address(consumerB));

        vm.startPrank(owner);
        provider.setConsumerStatus(address(consumerA), true, 8);
        provider.setConsumerStatus(address(consumerB), true, 8);
        vm.stopPrank();
    }

    function _randomRange(uint256 seed, uint256 idx) internal pure returns (RandomDeriveLib.Range memory r) {
        uint128 minVal = uint128(uint256(keccak256(abi.encode(seed, idx))) % 1000);
        uint128 maxVal = minVal + 1 + uint128(uint256(keccak256(abi.encode(seed, idx, 1))) % 1000);
        r.min = minVal;
        r.max = maxVal;
    }

    function request(uint256 seed) external {
        address selected = consumers[seed % consumers.length];
        uint8 count = uint8((seed % 5) + 1); // 1..5 ranges

        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](count);
        for (uint256 i = 0; i < count; i++) {
            ranges[i] = _randomRange(seed, i);
        }

        vm.prank(selected);
        lastRequestId = provider.requestRandomNumbers(ranges);
    }

    function fulfill(uint256 seed) external {
        if (lastRequestId == 0) return;
        uint256 requestId = uint256(keccak256(abi.encode(lastRequestId, seed))) % (lastRequestId + 1);
        if (provider.getRequestStatus(requestId) != RandomProvider.RequestStatus.Pending) {
            return;
        }

        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256(abi.encode(seed, block.timestamp)));

        vm.prank(address(coordinator));
        coordinator.fulfill(address(provider), requestId, words);
    }

    function forceTimeout(uint256 seed) external {
        if (lastRequestId == 0) return;
        uint256 requestId = uint256(keccak256(abi.encode(seed, lastRequestId))) % (lastRequestId + 1);
        if (provider.getRequestStatus(requestId) != RandomProvider.RequestStatus.Pending) {
            return;
        }

        vm.warp(block.timestamp + provider.REQUEST_TIMEOUT() + 1);

        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256(abi.encode(seed, 999)));

        vm.prank(address(coordinator));
        coordinator.fulfill(address(provider), requestId, words);
    }
}

contract RandomProviderInvariant is StdInvariant, Test {
    using RandomDeriveLib for uint256;

    RandomProvider internal provider;
    MockVRFCoordinatorV2Plus internal coordinator;
    RandomProviderHandler internal handler;

    address internal constant OWNER = address(0xA11CE);

    function setUp() public {
        vm.startPrank(OWNER);
        coordinator = new MockVRFCoordinatorV2Plus();
        provider = new RandomProvider(address(coordinator));
        provider.setKeyHash(bytes32(uint256(1)));
        provider.setSubscriptionId(1);
        vm.stopPrank();

        handler = new RandomProviderHandler(provider, coordinator, OWNER);

        targetContract(address(handler));
        targetSender(address(this));
    }

    function invariant_pendingIdsMatchStatus() public {
        uint256[] memory pending = provider.getPendingRequestIds();
        for (uint256 i = 0; i < pending.length; i++) {
            assertEq(
                uint256(provider.getRequestStatus(pending[i])),
                uint256(RandomProvider.RequestStatus.Pending),
                "pending list contains non-pending id"
            );
        }
    }

    function invariant_requestCountsConsistent() public {
        uint256[] memory allIds = provider.getAllRequestIds();
        assertEq(allIds.length, provider.totalRequests(), "totalRequests mismatch");
    }

    function invariant_rangesMatchCounts() public {
        uint256[] memory allIds = provider.getAllRequestIds();
        for (uint256 i = 0; i < allIds.length; i++) {
            RandomProvider.RequestData memory data = provider.getRequestData(allIds[i]);
            if (data.status == RandomProvider.RequestStatus.NonExistent) {
                continue;
            }
            uint256[] memory derived = provider.getDerivedValues(allIds[i]);
            if (derived.length > 0) {
                assertEq(derived.length, data.rangeCount, "derived length mismatch rangeCount");
            }
        }
    }

    function invariant_consumerRequestCountMatches() public {
        address[] memory consumers = new address[](2);
        consumers[0] = address(handler.consumerA());
        consumers[1] = address(handler.consumerB());

        for (uint256 i = 0; i < consumers.length; i++) {
            uint256 expected = provider.getConsumerRequests(consumers[i]).length;
            assertEq(expected, provider.getConsumerRequestCount(consumers[i]), "consumer request count mismatch");
        }
    }

    function invariant_failedRequestsHaveFailureInfo() public {
        uint256[] memory ids = provider.getAllRequestIds();
        for (uint256 i = 0; i < ids.length; i++) {
            RandomProvider.RequestData memory data = provider.getRequestData(ids[i]);
            if (data.status == RandomProvider.RequestStatus.Failed) {
                uint256 derivedLen = provider.getDerivedValues(ids[i]).length;
                assertTrue(
                    derivedLen == 0 || derivedLen == data.rangeCount,
                    "failed request derived length unexpected"
                );
                assertEq(
                    uint256(data.status),
                    uint256(RandomProvider.RequestStatus.Failed),
                    "status mismatch"
                );
            }
        }
    }
}
