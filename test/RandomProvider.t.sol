// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "forge-std/Test.sol";
import {RandomProvider, ExceedsMaxRanges, InvalidMaxNumber, RequestTimedOut, UnauthorizedCaller} from "contracts/RandomProvider.sol";
import {MockVRFCoordinatorV2Plus} from "contracts/mocks/MockVRFCoordinatorV2Plus.sol";
import {MockRandomConsumer, IRandomRequestor} from "contracts/mocks/MockRandomConsumer.sol";
import {RandomDeriveLib} from "contracts/libraries/RandomDeriveLib.sol";

contract RandomProviderTest is Test {
    using RandomDeriveLib for uint256;

    RandomProvider internal provider;
    MockVRFCoordinatorV2Plus internal coordinator;
    MockRandomConsumer internal consumer;
    MockRandomConsumer internal consumer2;

    address internal constant OWNER = address(0xA11CE);
    address internal constant OTHER = address(0xBEEF);

    function setUp() public {
        vm.startPrank(OWNER);
        coordinator = new MockVRFCoordinatorV2Plus();
        provider = new RandomProvider(address(coordinator));

        provider.setKeyHash(bytes32(uint256(1)));
        provider.setSubscriptionId(1);

        consumer = new MockRandomConsumer(address(provider));
        consumer2 = new MockRandomConsumer(address(provider));

        provider.setConsumerStatus(address(consumer), true, 10);
        provider.setConsumerStatus(address(consumer2), true, 5);
        vm.stopPrank();
    }

    function _singleRange(uint128 min, uint128 max) internal pure returns (RandomDeriveLib.Range memory) {
        RandomDeriveLib.Range memory r;
        r.min = min;
        r.max = max;
        return r;
    }

    function test_requestSingleNumber() public {
        vm.prank(address(consumer));
        uint256 requestId = consumer.requestSingle(100);

        uint256[] memory words = new uint256[](1);
        words[0] = 123456789;

        vm.prank(address(coordinator));
        coordinator.fulfill(address(provider), requestId, words);

        assertEq(uint256(provider.getRequestStatus(requestId)), uint256(RandomProvider.RequestStatus.Fulfilled));
        assertEq(provider.getRawWord(requestId), 123456789);

        uint256[] memory derived = provider.getDerivedValues(requestId);
        assertEq(derived.length, 1);
        assertLt(derived[0], 100);
    }

    function test_requestMultipleRanges() public {
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](3);
        ranges[0] = _singleRange(0, 100);
        ranges[1] = _singleRange(200, 250);
        ranges[2] = _singleRange(5, 10);

        vm.prank(address(consumer));
        uint256 requestId = consumer.requestRanges(ranges);

        uint256[] memory words = new uint256[](1);
        words[0] = 987654321;

        vm.prank(address(coordinator));
        coordinator.fulfill(address(provider), requestId, words);

        uint256[] memory derived = provider.getDerivedValues(requestId);
        assertEq(derived.length, 3);
        assertLt(derived[0], 100);
        assertGe(derived[1], 200);
        assertLt(derived[1], 250);
        assertGe(derived[2], 5);
        assertLt(derived[2], 10);

    }

    function test_requestSingleRevertsWhenMaxZero() public {
        vm.prank(address(consumer));
        vm.expectRevert(InvalidMaxNumber.selector);
        consumer.requestSingle(0);
    }

    function test_requestRangesRevertsWhenBoundsInvalid() public {
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = _singleRange(10, 10);

        vm.prank(address(consumer));
        vm.expectRevert(InvalidMaxNumber.selector);
        provider.requestRandomNumbers(ranges);
    }

    function test_requestFailsWhenConsumerReverts() public {
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = _singleRange(0, 100);

        vm.prank(address(consumer));
        uint256 requestId = consumer.requestRanges(ranges);

        consumer.setShouldRevert(true, "fail");

        uint256[] memory words = new uint256[](1);
        words[0] = 1;

        vm.prank(address(coordinator));
        coordinator.fulfill(address(provider), requestId, words);

        assertEq(uint256(provider.getRequestStatus(requestId)), uint256(RandomProvider.RequestStatus.Failed));
    }

    function test_revertIfRangesExceedLimit() public {
        vm.prank(OWNER);
        provider.setConsumerStatus(address(consumer), true, 1);

        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](2);
        ranges[0] = _singleRange(0, 5);
        ranges[1] = _singleRange(0, 5);

        vm.prank(address(consumer));
        vm.expectRevert(ExceedsMaxRanges.selector);
        provider.requestRandomNumbers(ranges);
    }

    function test_timeoutTriggersFailureNotification() public {
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = _singleRange(0, 10);

        vm.prank(address(consumer));
        uint256 requestId = consumer.requestRanges(ranges);

        vm.warp(block.timestamp + provider.REQUEST_TIMEOUT() + 1);

        uint256[] memory words = new uint256[](1);
        words[0] = 42;

        vm.prank(address(coordinator));
        coordinator.fulfill(address(provider), requestId, words);

        assertEq(uint256(provider.getRequestStatus(requestId)), uint256(RandomProvider.RequestStatus.Failed));
        assertEq(consumer.lastFailureRequestId(), requestId);
        assertEq(consumer.lastFailureReason(), provider.failureReasonTimeout());
    }

    function test_setConfigAndKeyHash() public {
        vm.prank(OWNER);
        provider.setKeyHash(bytes32(uint256(999)));
        vm.prank(OWNER);
        provider.setConfig(10, 500000, 1000);

        assertEq(provider.keyHash(), bytes32(uint256(999)));
        assertEq(provider.requestConfirmations(), 10);
    }

    function test_onlyAllowedConsumer() public {
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = _singleRange(0, 10);

        vm.prank(OTHER);
        vm.expectRevert(UnauthorizedCaller.selector);
        provider.requestRandomNumbers(ranges);
    }

    function test_gettersTrackRequests() public {
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = _singleRange(0, 10);

        vm.prank(address(consumer));
        uint256 requestId = consumer.requestRanges(ranges);

        uint256[] memory words = new uint256[](1);
        words[0] = 77;

        vm.prank(address(coordinator));
        coordinator.fulfill(address(provider), requestId, words);

        RandomProvider.RequestStatus status = provider.getRequestStatus(requestId);
        assertEq(uint256(status), uint256(RandomProvider.RequestStatus.Fulfilled));

        uint256[] memory consumerIds = provider.getConsumerRequests(address(consumer));
        assertEq(consumerIds.length, 1);
        assertEq(consumerIds[0], requestId);

        uint256[] memory allIds = provider.getAllRequestIds();
        assertEq(allIds.length, 1);
        assertEq(allIds[0], requestId);
    }

    function test_multipleConsumersIndependentTracking() public {
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = _singleRange(0, 100);

        vm.prank(address(consumer));
        uint256 requestId1 = consumer.requestRanges(ranges);

        vm.prank(address(consumer2));
        uint256 requestId2 = consumer2.requestRanges(ranges);

        uint256[] memory words = new uint256[](1);
        words[0] = 5;

        vm.prank(address(coordinator));
        coordinator.fulfill(address(provider), requestId1, words);

        vm.prank(address(coordinator));
        coordinator.fulfill(address(provider), requestId2, words);

        assertEq(provider.getConsumerRequestCount(address(consumer)), 1);
        assertEq(provider.getConsumerRequestCount(address(consumer2)), 1);
    }

    function test_ownerOnlyFunctions() public {
        vm.prank(OTHER);
        vm.expectRevert("Only callable by owner");
        provider.setKeyHash(bytes32(uint256(2)));

        vm.prank(OTHER);
        vm.expectRevert("Only callable by owner");
        provider.setConfig(3, 400000, 900);
    }

    function testFuzz_rangesWithinBounds(uint256 seed, uint8 count) public {
        vm.assume(count > 0 && count <= 8);

        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](count);
        for (uint256 i = 0; i < count; i++) {
            uint128 minVal = uint128(uint256(keccak256(abi.encode(seed, i))) % 50);
            uint128 maxVal = minVal + 1 + uint128(uint256(keccak256(abi.encode(seed, i, 1))) % 50);
            ranges[i] = _singleRange(minVal, maxVal);
        }

        vm.prank(address(consumer));
        uint256 requestId = provider.requestRandomNumbers(ranges);

        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256(abi.encode(seed, 777)));

        vm.prank(address(coordinator));
        coordinator.fulfill(address(provider), requestId, words);

        uint256[] memory derived = provider.getDerivedValues(requestId);
        assertEq(derived.length, count);
        for (uint256 i = 0; i < count; i++) {
            assertGe(derived[i], ranges[i].min);
            assertLt(derived[i], ranges[i].max);
        }
    }

    function test_consumerReceivesTimeoutFailure() public {
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = _singleRange(0, 10);

        vm.prank(address(consumer));
        uint256 requestId = consumer.requestRanges(ranges);

        vm.warp(block.timestamp + provider.REQUEST_TIMEOUT() + 1);

        uint256[] memory words = new uint256[](1);
        words[0] = 1;

        vm.prank(address(coordinator));
        coordinator.fulfill(address(provider), requestId, words);

        assertEq(uint256(provider.getRequestStatus(requestId)), uint256(RandomProvider.RequestStatus.Failed));
        assertEq(consumer.lastFailureRequestId(), requestId);
        assertEq(consumer.lastFailureReason(), provider.failureReasonTimeout());
    }

    function test_consumerReceivesFailureWhenFulfillReverts() public {
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = _singleRange(0, 10);

        vm.prank(address(consumer));
        uint256 requestId = consumer.requestRanges(ranges);

        consumer.setShouldRevert(true, "bad fulfill");

        uint256[] memory words = new uint256[](1);
        words[0] = 55;

        vm.prank(address(coordinator));
        coordinator.fulfill(address(provider), requestId, words);

        assertEq(uint256(provider.getRequestStatus(requestId)), uint256(RandomProvider.RequestStatus.Failed));
        assertEq(consumer.lastFailureRequestId(), requestId);
        assertEq(consumer.lastFailureReason(), provider.failureReasonConsumerRevert());
    }
}

