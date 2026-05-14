// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {AuthHub} from "../../auth/AuthHub.sol";

/**
 * @title AuthHubHarness
 * @notice Test-only inheritor of AuthHub that exposes the `_setKey` internal so
 *         coverage tests can exercise its defensive branches directly.
 *
 *         Production code reaches `_setKey` exclusively through `authorize`
 *         (msg.sender is always non-zero) or `authorizeFor` (ECDSA recovery
 *         cannot return address(0)), which means the `player == address(0)`
 *         revert path inside `_setKey` is unreachable through normal entries.
 *         The harness lets a test hit it without removing the defensive check.
 *
 *         NEVER deploy this on any non-test network.
 */
contract AuthHubHarness is AuthHub {
    function harness_setKey(
        address player,
        address sessionKey,
        uint64 expiresAt,
        uint128 spendCap
    ) external {
        _setKey(player, sessionKey, expiresAt, spendCap);
    }
}
