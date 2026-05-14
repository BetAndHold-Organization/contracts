// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {VRFGameBase} from "./VRFGameBase.sol";
import {JackpotClient} from "./JackpotClient.sol";
import {SignedActionAuth} from "./SignedActionAuth.sol";
import {GameLifecycleRoles} from "./GameLifecycleRoles.sol";
import {IGameEvents} from "./IGameEvents.sol";
import {Multicallable} from "./Multicallable.sol";
import {IPaymentHandlerMinimal} from "../../interfaces/core/IPaymentHandlerMinimal.sol";
import {IRandomProviderPullReader} from "../../interfaces/core/IRandomProviderPullReader.sol";

/**
 * @title PullVRFGame
 * @notice Canonical inheritance bundle for VRF pull-model games (Mines-style).
 *
 *         Inherit this if your game has the shape:
 *           player places bet → VRF request → ... player actions / state transitions ...
 *             → game reads VRF result on-demand → settle.
 *
 *         The platform's RandomProvider attempts to push-call fulfillRandomness when VRF
 *         lands. This base supplies NO-OP implementations of fulfillRandomness and
 *         handleRandomFailure so the push doesn't revert in RandomProvider's try/catch
 *         (which silently wastes LINK on every settlement when the consumer doesn't
 *         implement the callback). The actual VRF word is read via _readRandomWord() at
 *         settle time.
 *
 *         What you inherit:
 *           - Everything in PushVRFGame minus the obligation to write fulfillRandomness /
 *             handleRandomFailure (both are no-ops here and CANNOT be overridden).
 *           - _readRandomWord(requestId) — read the raw VRF word stored on RandomProvider.
 *
 *         If you need both push semantics for some bets AND pull semantics for others,
 *         use PushVRFGame and accept the LINK cost. The pull base is for games where
 *         the settle path is fundamentally not VRF-driven (commit/reveal, multi-step).
 */
abstract contract PullVRFGame is
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

    /// @notice No-op VRF callback. Pull games read getRawWord(requestId) at settle time
    ///         rather than acting in the push callback. This implementation exists so
    ///         RandomProvider's push call doesn't revert and waste LINK.
    /// @dev    NOT overridable. The whole point of this base is the no-op.
    function fulfillRandomness(
        uint256,
        uint256,
        uint256[] memory
    ) external override onlyRandomProvider nonReentrant {}

    /// @notice No-op VRF failure handler. Pull games detect VRF failure when their settle
    ///         path reads getRawWord and finds 0 — failure recovery is game-specific
    ///         (e.g. resolveAbandoned, cancelExpired) and triggered by the operator, not
    ///         by VRF's failure callback.
    /// @dev    NOT overridable.
    function handleRandomFailure(
        uint256,
        bytes32,
        bytes calldata
    ) external override onlyRandomProvider nonReentrant {}

    /// @dev Read the raw VRF word stored on the RandomProvider. Returns 0 if VRF
    ///      hasn't fulfilled yet — settle paths should check this and revert with
    ///      a game-specific error (e.g. RandomNotReady).
    function _readRandomWord(uint256 requestId) internal view returns (uint256) {
        return IRandomProviderPullReader(address(randomProvider)).getRawWord(requestId);
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
