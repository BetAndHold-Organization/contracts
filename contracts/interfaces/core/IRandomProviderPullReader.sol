// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/**
 * @title IRandomProviderPullReader
 * @notice Extends the minimal provider interface with the pull-model read function.
 *         Used by PullVRFGame-style games that read the raw VRF word at settle time
 *         instead of relying on the push callback.
 */
interface IRandomProviderPullReader {
    function getRawWord(uint256 requestId) external view returns (uint256);
}
