// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {PullVRFGame} from "../../games/base/PullVRFGame.sol";
import {IPaymentHandlerMinimal} from "../../interfaces/core/IPaymentHandlerMinimal.sol";

/**
 * @title PullVRFGameHarness
 * @notice Minimal concrete inheritor of PullVRFGame for coverage tests.
 *         Exposes `_paymentHandler()` (the JackpotClient hook PullVRFGame
 *         implements) so a test can exercise its body directly without
 *         needing a real jackpot-enabled bet flow.
 *
 *         NEVER deploy this on any non-test network.
 */
contract PullVRFGameHarness is PullVRFGame {
    constructor(
        address token,
        address handler,
        address provider,
        address authHub,
        address initialOperator
    )
        PullVRFGame(token, handler, provider, authHub, "PullVRFGameHarness", "1", initialOperator)
    {}

    /// @notice External wrapper around the internal `_paymentHandler()` hook
    ///         so coverage tests can read its return value.
    function harness_paymentHandler() external view returns (IPaymentHandlerMinimal) {
        return _paymentHandler();
    }

    /// @notice External wrapper around the internal `_readRandomWord` reader.
    function harness_readRandomWord(uint256 requestId) external view returns (uint256) {
        return _readRandomWord(requestId);
    }
}
