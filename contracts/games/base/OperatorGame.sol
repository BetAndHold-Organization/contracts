// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {BaseGame} from "./BaseGame.sol";
import {SignedActionAuth} from "./SignedActionAuth.sol";
import {GameLifecycleRoles} from "./GameLifecycleRoles.sol";
import {IGameEvents} from "./IGameEvents.sol";
import {Multicallable} from "./Multicallable.sol";

/**
 * @title OperatorGame
 * @notice Canonical inheritance bundle for games without on-chain randomness.
 *
 *         Inherit this if your game has the shape:
 *           player places bet (or operator places bet via *For) → operator settles based
 *           on off-chain outcome → settle.
 *
 *         Examples: PaymentOnlyGameAdapter (off-chain game with on-chain settlement),
 *         TicketLottery (operator-driven batch with VRF on the coordinator directly, not
 *         the platform's RandomProvider).
 *
 *         What you inherit:
 *           - BaseGame:           token, paymentHandler, lockedExposure, pause, emergencyWithdraw
 *           - SignedActionAuth:   onlyOperator modifier + _verifyAndConsume for *For entries
 *           - GameLifecycleRoles: gameOperators allowlist + onlyGameOperator modifier
 *           - IGameEvents:        BetPlaced / BetSettled / BetFailed envelope
 *
 *         Notable absence: no VRFGameBase (no Chainlink VRF integration) and no
 *         JackpotClient (operator games typically don't participate in the platform jackpot).
 *         If you need either, inherit them explicitly alongside this base.
 *
 *         The *For convention (typehash with `address game`, internal helper template)
 *         is identical to PushVRFGame's. See that contract's doc comment for the pattern.
 */
abstract contract OperatorGame is
    BaseGame,
    SignedActionAuth,
    GameLifecycleRoles,
    IGameEvents
{
    constructor(
        address token,
        address handler,
        address authHub,
        string memory eip712Name,
        string memory eip712Version,
        address initialOperator
    )
        BaseGame(token, handler)
        SignedActionAuth(eip712Name, eip712Version, authHub)
    {
        if (initialOperator != address(0)) {
            _setGameOperator(initialOperator, true);
        }
    }

    function setGameOperator(address operator, bool status) external onlyOwner {
        _setGameOperator(operator, status);
    }

    function setGameOperators(address[] calldata operators, bool status) external onlyOwner {
        for (uint256 i = 0; i < operators.length; i++) {
            _setGameOperator(operators[i], status);
        }
    }

    /// @inheritdoc Multicallable
    function _multicallAuthorized(address caller) internal view override returns (bool) {
        return authHub.isOperator(caller);
    }
}
