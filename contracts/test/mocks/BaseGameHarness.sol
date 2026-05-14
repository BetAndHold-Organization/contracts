// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {BaseGame} from "../../games/base/BaseGame.sol";

/**
 * @title BaseGameHarness
 * @notice Test-only concrete inheritor of BaseGame that exposes its internal
 *         fund-movement and exposure-management primitives as public functions,
 *         and supplies a direct setter for `lockedExposure` so tests can
 *         construct edge-case scenarios (e.g. the `_unlockExposure` underflow
 *         branch where reduction > lockedExposure).
 *
 *         Multicallable's abstract `_multicallAuthorized` hook is satisfied
 *         with an always-true stub. The harness is not gated by AuthHub
 *         because tests don't exercise its multicall path — only the BaseGame
 *         primitives that have no other realistic test surface.
 *
 *         NEVER deploy this on any non-test network.
 */
contract BaseGameHarness is BaseGame {
    constructor(address token, address handler) BaseGame(token, handler) {}

    // ── Exposure primitives ───────────────────────────────────────────────────

    function harness_lockExposure(uint256 maxPayout, uint256 jackpotContribution) external {
        _lockExposure(maxPayout, jackpotContribution);
    }

    function harness_unlockExposure(uint256 maxPayout, uint256 jackpotContribution) external {
        _unlockExposure(maxPayout, jackpotContribution);
    }

    /// @dev Direct state mutator so a test can simulate "lockedExposure < reduction"
    ///      without going through normal flow.
    function harness_setLockedExposure(uint256 newValue) external {
        lockedExposure = newValue;
    }

    // ── Fund-movement primitives ──────────────────────────────────────────────

    function harness_collectBet(address player, uint256 amount) external {
        _collectBet(player, amount);
    }

    function harness_processBet(address bettor, address referrer, uint256 amount)
        external
        returns (uint256 netStake)
    {
        return _processBet(bettor, referrer, amount);
    }

    function harness_collectAndProcessBet(address player, address referrer, uint256 amount)
        external
        returns (uint256 netStake)
    {
        return _collectAndProcessBet(player, referrer, amount);
    }

    function harness_payPlayer(address player, uint256 amount) external {
        _payPlayer(player, amount);
    }

    // ── Multicallable hook stub ──────────────────────────────────────────────

    /// @dev Always returns true for the harness so any caller can drive the
    ///      batch loop in coverage tests. Real games supply an AuthHub-backed
    ///      implementation via the shape bases.
    function _multicallAuthorized(address) internal pure override returns (bool) {
        return true;
    }
}
