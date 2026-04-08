// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPaymentHandlerMinimal} from "../interfaces/IPaymentHandlerMinimal.sol";

/**
 * @title BaseGame
 * @notice Abstract base for all games in the ecosystem. Encapsulates:
 *         - ERC20 token management
 *         - PaymentHandler integration (player -> game -> handler flow)
 *         - Exposure locking for pending bets
 *         - Emergency withdrawal
 */
abstract contract BaseGame is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════

    IERC20 public immutable evaToken;
    IPaymentHandlerMinimal public paymentHandler;
    uint256 public lockedExposure;

    // ═══════════════════════════════════════════════════════════════════════
    //                              ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error LiquidityShortfall(uint256 available, uint256 required);
    error PaymentHandlerMisconfigured();

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(address token, address handler) {
        if (token == address(0) || handler == address(0)) {
            revert PaymentHandlerMisconfigured();
        }
        evaToken = IERC20(token);
        paymentHandler = IPaymentHandlerMinimal(handler);
        IERC20(token).safeApprove(handler, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    function setPaymentHandler(address newHandler) external onlyOwner {
        require(newHandler != address(0), "Invalid handler");
        address oldHandler = address(paymentHandler);
        if (oldHandler != address(0)) {
            evaToken.safeApprove(oldHandler, 0);
        }
        paymentHandler = IPaymentHandlerMinimal(newHandler);
        evaToken.safeApprove(newHandler, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              FUND MOVEMENT
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @dev Pull tokens from the player into this contract.
     *      Player must have approved this game contract.
     */
    function _collectBet(address player, uint256 amount) internal {
        evaToken.safeTransferFrom(player, address(this), amount);
    }

    /**
     * @dev Forward a bet through the PaymentHandler (fees, referrals).
     *      The handler pulls tokens from this contract via its allowance.
     * @return netStake The amount remaining after handler deductions.
     */
    function _processBet(address bettor, address referrer, uint256 amount) internal returns (uint256 netStake) {
        netStake = paymentHandler.processDirectBetFromGame(bettor, referrer, amount);
    }

    /**
     * @dev Convenience: pull from player and process in one step.
     * @return netStake The amount remaining after handler deductions.
     */
    function _collectAndProcessBet(address player, address referrer, uint256 amount) internal returns (uint256 netStake) {
        _collectBet(player, amount);
        netStake = _processBet(player, referrer, amount);
    }

    /**
     * @dev Transfer tokens to a player (winnings, refunds).
     */
    function _payPlayer(address player, uint256 amount) internal {
        evaToken.safeTransfer(player, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              EXPOSURE
    // ═══════════════════════════════════════════════════════════════════════

    function _lockExposure(uint256 maxPayout, uint256 jackpotContribution) internal {
        uint256 proposedLocked = lockedExposure + maxPayout + jackpotContribution;
        uint256 balance = evaToken.balanceOf(address(this));
        if (balance < proposedLocked) revert LiquidityShortfall(balance, proposedLocked);
        lockedExposure = proposedLocked;
    }

    function _unlockExposure(uint256 maxPayout, uint256 jackpotContribution) internal {
        uint256 reduction = maxPayout + jackpotContribution;
        if (lockedExposure < reduction) {
            lockedExposure = 0;
        } else {
            lockedExposure -= reduction;
        }
    }

    function availableLiquidity() external view returns (uint256) {
        uint256 balance = evaToken.balanceOf(address(this));
        if (balance <= lockedExposure) return 0;
        return balance - lockedExposure;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              EMERGENCY
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Withdraw all or part of the token balance. Override to reset
     *         internal accounting (e.g. pot balances) when needed.
     */
    function emergencyWithdraw(address to, uint256 amount) external virtual onlyOwner nonReentrant {
        require(to != address(0), "to");
        uint256 bal = evaToken.balanceOf(address(this));
        uint256 amt = amount == 0 ? bal : amount;
        require(amt <= bal, "insufficient");
        evaToken.safeTransfer(to, amt);
    }
}
