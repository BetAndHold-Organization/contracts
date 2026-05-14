// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {VRFGameBase} from "./VRFGameBase.sol";
import {JackpotClient} from "./JackpotClient.sol";
import {SignedActionAuth} from "./SignedActionAuth.sol";
import {GameLifecycleRoles} from "./GameLifecycleRoles.sol";
import {IGameEvents} from "./IGameEvents.sol";
import {Multicallable} from "./Multicallable.sol";
import {IPaymentHandlerMinimal} from "../../interfaces/core/IPaymentHandlerMinimal.sol";

/**
 * @title PushVRFGame
 * @notice Canonical inheritance bundle for VRF push-model games.
 *
 *         Inherit this if your game has the shape:
 *           player places bet → VRF request → callback resolves and pays inline
 *
 *         Examples: SingleRandomRoulette, MultiLineSlots, Plinko, ProgressiveJackpot direct bets.
 *         For multi-stage games (Mines) use PullVRFGame. For non-VRF games use OperatorGame.
 *
 *         What you inherit:
 *           - BaseGame:           token, paymentHandler, lockedExposure, pause, emergencyWithdraw
 *           - VRFGameBase:        randomProvider + onlyRandomProvider modifier (Pausable from BaseGame)
 *           - JackpotClient:      _enterJackpot / _ensureJackpotPayable / _jackpotRollCap
 *           - SignedActionAuth:   onlyOperator modifier + _verifyAndConsume for *For entries
 *           - GameLifecycleRoles: gameOperators allowlist + onlyGameOperator modifier
 *           - IGameEvents:        BetPlaced / BetSettled / BetFailed envelope
 *
 *         Implementing a game:
 *           1. Inherit this contract.
 *           2. Implement fulfillRandomness(requestId, randomWord, derivedValues).
 *           3. Implement handleRandomFailure(requestId, reason, details). (Each game decides
 *              its refund policy — there is no platform default.)
 *           4. Define your bet entry (e.g. placeBet) and its delegated counterpart (placeBetFor)
 *              following this convention:
 *
 *                bytes32 public constant XXX_TYPEHASH = keccak256(
 *                    "DoSomething(address game,address player,...,uint256 nonce,uint256 deadline)"
 *                );
 *                // ^ `address game` MUST be first after typehash name. Binds the signature
 *                //   to this contract — prevents cross-game signature replay.
 *
 *                function xxx(...args) external nonReentrant returns (uint256 requestId) {
 *                    return _xxxInternal(msg.sender, ...args);
 *                }
 *
 *                function xxxFor(address player, ...args, uint256 nonce, uint256 deadline, bytes calldata sig)
 *                    external onlyOperator nonReentrant returns (uint256 requestId)
 *                {
 *                    bytes32 structHash = keccak256(abi.encode(
 *                        XXX_TYPEHASH, address(this), player, ...args, nonce, deadline
 *                    ));
 *                    _verifyAndConsume(player, address(this), betAmount, structHash, deadline, nonce, sig);
 *                    return _xxxInternal(player, ...args);
 *                }
 *
 *                function _xxxInternal(address bettor, ...args) internal returns (uint256 requestId) {
 *                    // Shared logic. Use `bettor` instead of msg.sender so events / state /
 *                    // payouts reference the actual player on both direct and delegated paths.
 *                }
 *
 *           5. Emit BetPlaced when the bet is registered, BetSettled when fulfillRandomness
 *              resolves it, BetFailed if handleRandomFailure aborts it. Game-specific outcome
 *              data goes in the `data` blob.
 */
abstract contract PushVRFGame is
    VRFGameBase,
    JackpotClient,
    SignedActionAuth,
    GameLifecycleRoles,
    IGameEvents
{
    constructor(
        address token,
        address handler,
        address provider,
        address authHub,
        string memory eip712Name,
        string memory eip712Version,
        address initialOperator
    )
        VRFGameBase(token, handler, provider)
        SignedActionAuth(eip712Name, eip712Version, authHub)
    {
        if (initialOperator != address(0)) {
            _setGameOperator(initialOperator, true);
        }
    }

    /// @inheritdoc JackpotClient
    function _paymentHandler() internal view override returns (IPaymentHandlerMinimal) {
        return paymentHandler;
    }

    /// @notice Two-batch helper for setting game operators from owner-gated wrappers.
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
