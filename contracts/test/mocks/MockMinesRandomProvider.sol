// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {RandomDeriveLib} from "../../libraries/RandomDeriveLib.sol";

/// @dev Minimal mock implementing IMinesRandomProvider's surface for tests.
///      `requestRandomNumbers` returns an incrementing requestId; tests then
///      seed `setRawWord(requestId, word)` to control the VRF outcome.
contract MockMinesRandomProvider {
    uint256 public nextRequestId = 1;
    mapping(uint256 => uint256) private rawWords;

    event MinesRequestCreated(uint256 indexed requestId, address indexed sender);

    function requestRandomNumber(uint256 /*maxNumber*/) external returns (uint256 requestId) {
        requestId = nextRequestId++;
        emit MinesRequestCreated(requestId, msg.sender);
    }

    function requestRandomNumbers(RandomDeriveLib.Range[] calldata /*ranges*/) external returns (uint256 requestId) {
        requestId = nextRequestId++;
        emit MinesRequestCreated(requestId, msg.sender);
    }

    function setRawWord(uint256 requestId, uint256 word) external {
        rawWords[requestId] = word;
    }

    function getRawWord(uint256 requestId) external view returns (uint256) {
        return rawWords[requestId];
    }
}
