// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {SignedActionAuth} from "../../games/base/SignedActionAuth.sol";

/**
 * @title SignedActionAuthHarness
 * @notice Test-only inheritor of SignedActionAuth that exposes `_verifyAndConsume`
 *         as an external function so coverage tests can drive its cross-game
 *         replay-protection branch directly.
 *
 *         The `if (game != address(this)) revert WrongGame(...)` check inside
 *         `_verifyAndConsume` is unreachable through normal usage: every game
 *         contract passes its own `address(this)` to the helper, so a wrong
 *         `game` argument would require a buggy game implementation. The
 *         harness lets a test trigger the revert without producing such a bug.
 *
 *         NEVER deploy on a non-test network.
 */
contract SignedActionAuthHarness is SignedActionAuth {
    constructor(address authHub_) SignedActionAuth("SignedActionAuthHarness", "1", authHub_) {}

    function harness_verifyAndConsume(
        address player,
        address game,
        uint256 betAmount,
        bytes32 structHash,
        uint256 deadline,
        uint256 nonce,
        bytes calldata signature
    ) external {
        _verifyAndConsume(player, game, betAmount, structHash, deadline, nonce, signature);
    }
}
