// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {RandomDeriveLib} from "../../libraries/RandomDeriveLib.sol";

/**
 * @title IRandomProviderMinimal
 * @notice Canonical interface every VRF-driven game uses to request randomness
 *         and (optionally) read failure metadata from the platform RandomProvider.
 *
 *         New games MUST import this for any random-request call site — see
 *         GAME_AUTHOR_GUIDE for the rule. For PullVRFGame-style settle-time
 *         reads, also import `IRandomProviderPullReader` (kept separate so
 *         push-only games don't have to know about it).
 */
interface IRandomProviderMinimal {
    /// @notice Request one bounded random number in [0, maxNumber). Convenience
    ///         entry for games that only need one value.
    function requestRandomNumber(uint256 maxNumber) external returns (uint256 requestId);

    /// @notice Request multiple range-derived random numbers in one VRF call.
    function requestRandomNumbers(RandomDeriveLib.Range[] calldata ranges) external returns (uint256 requestId);

    /// @notice Status of a previously created request.
    ///         0 = NonExistent, 1 = Pending, 2 = Fulfilled, 3 = Failed.
    function getRequestStatus(uint256 requestId) external view returns (uint8 status);

    /// @notice Failure reason tags. Games implementing `handleRandomFailure`
    ///         can branch on these. Exposed as `pure` getters by the provider.
    function FAILURE_TIMEOUT() external pure returns (bytes32);
    function FAILURE_CONSUMER_REVERT() external pure returns (bytes32);
    function FAILURE_CONSUMER_ERROR() external pure returns (bytes32);
}
