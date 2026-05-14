// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IRandomConsumer} from "../../interfaces/core/IRandomConsumer.sol";
import {RandomDeriveLib} from "../../libraries/RandomDeriveLib.sol";

interface IRandomRequestor {
    function requestRandomNumber(uint256 maxNumber) external returns (uint256);
    function requestRandomNumbers(RandomDeriveLib.Range[] calldata ranges) external returns (uint256);
}

contract MockRandomConsumer is IRandomConsumer {
    uint256 public lastRequestId;
    uint256 public rawWord;
    uint256[] public derived;
    bool public shouldRevert;
    string public revertReason;
    bool public lowLevelFailure;
    bool public lowLevelFulfillFailure;
    IRandomRequestor public immutable provider;
    uint256 public lastFailureRequestId;
    bytes32 public lastFailureReason;

    event Fulfilled(uint256 requestId, uint256 word, uint256[] values);

    constructor(address provider_) {
        provider = IRandomRequestor(provider_);
    }

    function setShouldRevert(bool value, string calldata reason) external {
        shouldRevert = value;
        revertReason = reason;
    }

    function setLowLevelFailure(bool value) external {
        lowLevelFailure = value;
    }

    function setLowLevelFulfillFailure(bool value) external {
        lowLevelFulfillFailure = value;
    }

    function fulfillRandomness(
        uint256 requestId,
        uint256 randomWord,
        uint256[] memory derivedValues
    ) external override {
        if (lowLevelFulfillFailure) {
            assembly {
                revert(0, 0)
            }
        }
        if (shouldRevert) {
            revert(bytes(revertReason).length == 0 ? "Mock revert" : revertReason);
        }

        lastRequestId = requestId;
        rawWord = randomWord;
        derived = derivedValues;

        emit Fulfilled(requestId, randomWord, derivedValues);
    }

    function reset() external {
        delete lastRequestId;
        delete rawWord;
        delete derived;
        shouldRevert = false;
        revertReason = "";
        lowLevelFailure = false;
        lowLevelFulfillFailure = false;
    }

    function requestSingle(uint256 maxNumber) external returns (uint256) {
        return provider.requestRandomNumber(maxNumber);
    }

    function requestRanges(RandomDeriveLib.Range[] calldata ranges) external returns (uint256) {
        return provider.requestRandomNumbers(ranges);
    }

    function derivedLength() external view returns (uint256) {
        return derived.length;
    }

    function derivedValue(uint256 index) external view returns (uint256) {
        return derived[index];
    }

    function handleRandomFailure(
        uint256 requestId,
        bytes32 reason,
        bytes calldata /*details*/
    ) external override {
        if (lowLevelFailure) {
            assembly {
                revert(0, 0)
            }
        }
        lastFailureRequestId = requestId;
        lastFailureReason = reason;
    }
}

