// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {BaseGame} from "../../games/base/BaseGame.sol";
import {JackpotClient} from "../../games/base/JackpotClient.sol";
import {IPaymentHandlerMinimal} from "../../interfaces/core/IPaymentHandlerMinimal.sol";

/**
 * @title MockJackpotGame
 * @notice Minimal concrete BaseGame + JackpotClient inheritor that exposes the
 *         JackpotClient internal helpers as external functions so coverage
 *         tests can hit them without setting up a full jackpot-participating
 *         game flow.
 *
 *         Wired exactly like a real game: PaymentHandler is inherited from
 *         BaseGame, the JackpotClient hook returns it. The pieces exercised
 *         are `_enterJackpot`, `_activeJackpot`, `_jackpotRollCap` and
 *         `_ensureJackpotPayable`.
 *
 *         NEVER deploy on a non-test network.
 */
contract MockJackpotGame is BaseGame, JackpotClient {
    constructor(address token, address handler) BaseGame(token, handler) {}

    /// @inheritdoc JackpotClient
    function _paymentHandler() internal view override returns (IPaymentHandlerMinimal) {
        return paymentHandler;
    }

    /// @dev Always-allow stub for the Multicallable gate; the mock isn't used to
    ///      drive multicallTry, only the JackpotClient helpers below.
    function _multicallAuthorized(address) internal pure override returns (bool) {
        return true;
    }

    // ── JackpotClient passthroughs ────────────────────────────────────────────

    function harness_enterJackpot(address player, uint256 betAmount, uint256 roll)
        external
        returns (uint256 payout)
    {
        return _enterJackpot(player, betAmount, roll);
    }

    function harness_jackpotRollCap() external view returns (uint256) {
        return _jackpotRollCap();
    }

    function harness_ensureJackpotPayable(uint256 betAmount) external view {
        _ensureJackpotPayable(betAmount);
    }
}
