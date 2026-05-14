// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {IProgressiveJackpot} from "../../interfaces/core/IProgressiveJackpot.sol";
import {IPaymentHandlerMinimal} from "../../interfaces/core/IPaymentHandlerMinimal.sol";

/**
 * @title JackpotClient
 * @notice Mixin for games that participate in the platform-wide ProgressiveJackpot.
 *
 *         After PaymentHandler centralization (step 4):
 *         - Contributions to the jackpot are routed by PaymentHandler at bet time.
 *         - This mixin only handles the entry/resolution side: drawing on hits and
 *           checking solvency before accepting a bet.
 *
 *         The jackpot reference is read from the PaymentHandler on demand, so a
 *         platform-wide jackpot swap is a single admin tx on PaymentHandler with
 *         no per-game updates.
 *
 * @dev Inheriting contract must implement `_paymentHandler()` to expose its current
 *      PaymentHandler reference. BaseGame's public `paymentHandler` state can be
 *      returned directly.
 */
abstract contract JackpotClient {
    error JackpotNotConfigured();

    /// @dev Inheriting contract returns the active PaymentHandler.
    function _paymentHandler() internal view virtual returns (IPaymentHandlerMinimal);

    /// @dev Resolve the active jackpot via the PaymentHandler. Returns the zero address if unset.
    function _activeJackpot() internal view returns (IProgressiveJackpot) {
        return IProgressiveJackpot(_paymentHandler().getJackpot());
    }

    /// @notice Probability precision exposed by the active jackpot. Used by games as the upper
    ///         bound for jackpot rolls. Returns 0 if no jackpot is configured.
    function _jackpotRollCap() internal view returns (uint256) {
        IProgressiveJackpot j = _activeJackpot();
        return address(j) == address(0) ? 0 : j.PROBABILITY_PRECISION();
    }

    /**
     * @dev Enter the player into the jackpot draw. Returns payout (may be zero).
     *      No-op when no jackpot is configured.
     */
    function _enterJackpot(address player, uint256 betAmount, uint256 roll) internal returns (uint256 payout) {
        IProgressiveJackpot j = _activeJackpot();
        if (address(j) == address(0)) return 0;
        return j.processJackpotEntry(player, betAmount, roll);
    }

    /**
     * @dev Revert if the jackpot cannot pay out for the given bet size. No-op when unset.
     */
    function _ensureJackpotPayable(uint256 betAmount) internal view {
        IProgressiveJackpot j = _activeJackpot();
        if (address(j) != address(0)) {
            j.ensurePayable(address(this), betAmount);
        }
    }
}
