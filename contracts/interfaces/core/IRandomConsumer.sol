// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

interface IRandomConsumer {
    /**
     * @notice Called by RandomProvider when randomness is ready.
     * @param requestId The id of the randomness request.
     * @param randomWord The raw VRF word received from the coordinator.
     * @param derivedValues The bounded numbers produced using the requested ranges.
     */
    function fulfillRandomness(
        uint256 requestId,
        uint256 randomWord,
        uint256[] memory derivedValues
    ) external;

    /**
     * @notice Called by RandomProvider when a request cannot be fulfilled.
     * @param requestId The id of the randomness request.
     * @param reason Identifier describing the failure (e.g. keccak256("TIMEOUT")).
     * @param details Additional context encoded as bytes (may be empty).
     */
    function handleRandomFailure(
        uint256 requestId,
        bytes32 reason,
        bytes calldata details
    ) external;
}

