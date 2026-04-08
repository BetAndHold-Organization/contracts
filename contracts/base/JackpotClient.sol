// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IProgressiveJackpotV2} from "../interfaces/IProgressiveJackpotV2.sol";

/**
 * @title JackpotClient
 * @notice Mixin for games that interact with the Progressive Jackpot.
 *         Provides setJackpot (with approval management), deposit, entry, and payability checks.
 *
 *         Games that only contribute funds (e.g. Slots) use _depositToJackpot.
 *         Games that also enter players (e.g. Roulette) additionally use _enterJackpot / _ensureJackpotPayable.
 *
 * @dev Requires the inheriting contract to expose `evaToken` as an IERC20 immutable.
 *      Designed for diamond-style composition with BaseGame / VRFGameBase.
 */
abstract contract JackpotClient {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════

    IProgressiveJackpotV2 public jackpot;
    uint256 public jackpotRollCap;

    // ═══════════════════════════════════════════════════════════════════════
    //                              ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error JackpotNotConfigured();
    error ProbabilityOverflow();

    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event JackpotUpdated(address indexed jackpot, uint256 probabilityPrecision);

    // ═══════════════════════════════════════════════════════════════════════
    //                              ABSTRACT
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Must return the game's ERC20 token. Implemented by BaseGame.
    function _jackpotToken() internal view virtual returns (IERC20);

    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Set or clear the jackpot contract. Manages ERC20 approval automatically.
     * @dev Access control must be enforced by the inheriting contract (e.g. onlyOwner).
     */
    function _setJackpot(address newJackpot) internal {
        IERC20 token = _jackpotToken();
        address oldJackpot = address(jackpot);
        if (oldJackpot != address(0)) {
            token.safeApprove(oldJackpot, 0);
        }

        if (newJackpot == address(0)) {
            jackpot = IProgressiveJackpotV2(address(0));
            jackpotRollCap = 0;
            emit JackpotUpdated(address(0), 0);
            return;
        }

        IProgressiveJackpotV2 candidate = IProgressiveJackpotV2(newJackpot);
        uint256 precision = candidate.PROBABILITY_PRECISION();
        if (precision == 0 || precision > type(uint128).max) revert ProbabilityOverflow();

        jackpot = candidate;
        jackpotRollCap = precision;

        token.safeApprove(newJackpot, type(uint256).max);

        emit JackpotUpdated(newJackpot, precision);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @dev Send contribution to the jackpot via addFunds. No-op if jackpot is not set or amount is zero.
     */
    function _depositToJackpot(uint256 amount) internal {
        if (amount == 0 || address(jackpot) == address(0)) return;
        jackpot.addFunds(amount);
    }

    /**
     * @dev Enter the player into the jackpot draw. Returns payout (may be zero).
     */
    function _enterJackpot(address player, uint256 betAmount, uint256 roll) internal returns (uint256 payout) {
        payout = jackpot.processJackpotEntry(player, betAmount, roll);
    }

    /**
     * @dev Revert if the jackpot cannot pay out for the given bet size.
     */
    function _ensureJackpotPayable(uint256 betAmount) internal view {
        jackpot.ensurePayable(address(this), betAmount);
    }
}
