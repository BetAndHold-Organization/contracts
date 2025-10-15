// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "forge-std/Test.sol";
import {RandomDeriveLib} from "contracts/libraries/RandomDeriveLib.sol";

contract RandomDeriveLibHarness {
    function callDerive(uint256 seed, RandomDeriveLib.Range[] memory ranges)
        external
        pure
        returns (uint256[] memory values, uint256 nextSeed)
    {
        return RandomDeriveLib.deriveBounded(seed, ranges);
    }
}

contract RandomDeriveLibTest is Test {
    using RandomDeriveLib for uint256;

    RandomDeriveLibHarness internal harness;
    uint256 internal constant SEED = 12345678901234567890;

    function setUp() public {
        harness = new RandomDeriveLibHarness();
    }

    function _range(uint128 min_, uint128 max_) internal pure returns (RandomDeriveLib.Range memory r) {
        r.min = min_;
        r.max = max_;
    }

    function test_deriveBounded_singleRange() public view {
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = _range(10, 20);

        (uint256[] memory values, uint256 nextSeed) = RandomDeriveLib.deriveBounded(12345, ranges);

        assertEq(values.length, 1, "expected one value");
        assertGe(values[0], 10, "value below min");
        assertLt(values[0], 20, "value not less than max");
        assertTrue(nextSeed != 0, "next seed should be non-zero");
    }

    function test_deriveBounded_multipleRanges() public view {
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](3);
        ranges[0] = _range(0, 100);
        ranges[1] = _range(50, 60);
        ranges[2] = _range(1000, 2000);

        (uint256[] memory values, ) = RandomDeriveLib.deriveBounded(987654321, ranges);

        assertEq(values.length, 3);
        assertLt(values[0], 100);
        assertGe(values[1], 50);
        assertLt(values[1], 60);
        assertGe(values[2], 1000);
        assertLt(values[2], 2000);
    }

    function test_deriveOnce_matchesFirstValue() public view {
        uint256 seed = uint256(keccak256("seed"));
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](2);
        ranges[0] = _range(1, 100);
        ranges[1] = _range(500, 600);

        (uint256[] memory values, uint256 nextSeed) = RandomDeriveLib.deriveBounded(seed, ranges);

        (uint256 singleValue, uint256 nextAfterFirst) = RandomDeriveLib.deriveOnce(seed, ranges[0].min, ranges[0].max, 0);
        (uint256 secondValue, uint256 finalSeed) = RandomDeriveLib.deriveOnce(nextAfterFirst, ranges[1].min, ranges[1].max, 1);

        assertEq(values[0], singleValue, "first derive mismatch");
        assertEq(values[1], secondValue, "second derive mismatch");
        assertEq(nextSeed, finalSeed, "next seed mismatch");
    }

    function test_multipleCallsProduceDifferentNumbers() public view {
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](2);
        ranges[0] = _range(0, 1000);
        ranges[1] = _range(1000, 2000);

        (uint256[] memory first, ) = harness.callDerive(SEED, ranges);
        (uint256[] memory second, ) = harness.callDerive(SEED + 1, ranges);

        assertEq(first.length, 2);
        assertEq(second.length, 2);
        assertFalse(first[0] == second[0] && first[1] == second[1], "seeds should differ");
    }

    function test_multipleRangesPreserveBounds() public view {
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](4);
        ranges[0] = _range(0, 10);
        ranges[1] = _range(10, 20);
        ranges[2] = _range(20, 30);
        ranges[3] = _range(30, 40);

        (uint256[] memory values, ) = harness.callDerive(SEED, ranges);
        assertEq(values.length, 4);

        for (uint256 i = 0; i < ranges.length; i++) {
            assertGe(values[i], ranges[i].min);
            assertLt(values[i], ranges[i].max);
        }
    }

    function testFuzz_deriveBoundedWithinRange(uint256 seed, uint128 min, uint128 max) public view {
        vm.assume(max > min);
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = _range(min, max);

        (uint256[] memory values, ) = RandomDeriveLib.deriveBounded(seed, ranges);

        assertGe(values[0], min);
        assertLt(values[0], max);
    }

    function testFuzz_deriveWordSequence(uint256 seed, uint8 count) public pure {
        vm.assume(count < 32); // keep test reasonable

        (uint256[] memory words, uint256 lastSeed) = RandomDeriveLib.deriveWordSequence(seed, count);
        assertEq(words.length, count);

        if (count > 0) {
            uint256 expected = seed;
            for (uint256 i = 0; i < count; i++) {
                expected = uint256(keccak256(abi.encode(expected, i)));
            }
            assertEq(lastSeed, expected);
            assertEq(words[count - 1], expected);
        }
    }

    function testFuzz_multipleRanges(uint256 seed, uint8 count) public view {
        vm.assume(count > 0 && count <= 16);

        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](count);
        for (uint256 i = 0; i < count; i++) {
            uint128 minVal = uint128(uint256(keccak256(abi.encode(seed, i))) % 1000);
            uint128 maxVal = minVal + 1 + uint128(uint256(keccak256(abi.encode(seed, i, 1))) % 1000);
            ranges[i] = _range(minVal, maxVal);
        }

        (uint256[] memory values, ) = harness.callDerive(seed, ranges);

        assertEq(values.length, count);
        for (uint256 i = 0; i < count; i++) {
            assertGe(values[i], ranges[i].min);
            assertLt(values[i], ranges[i].max);
        }
    }

    function test_uniformityOverLargeRange() public {
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = _range(0, 1000);

        uint256 seed = 1;
        uint256[] memory buckets = new uint256[](10);

        for (uint256 i = 0; i < 1000; i++) {
            (uint256[] memory values, uint256 nextSeed) = harness.callDerive(seed, ranges);
            buckets[values[0] / 100] += 1;
            seed = nextSeed;
        }

        for (uint256 i = 0; i < buckets.length; i++) {
            assertLt(buckets[i], 200, "bucket imbalance");
            assertGt(buckets[i], 50, "bucket imbalance");
        }
    }

    function testRevert_invalidRange() public {
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = _range(100, 50);

        vm.expectRevert(abi.encodeWithSelector(RandomDeriveLib.InvalidRange.selector, uint256(0)));
        harness.callDerive(0, ranges);
    }
}

