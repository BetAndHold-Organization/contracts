// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ProgressiveJackpot} from "../../core/ProgressiveJackpot.sol";

/**
 * @title ProgressiveJackpotHarness
 * @notice Test-only inheritor of ProgressiveJackpot that exposes a few storage
 *         mutators + an internal helper so coverage tests can drive defensive
 *         branches that aren't reachable through public functions:
 *
 *           - `_validateOutcomes` rejects empty outcome arrays at registration,
 *             so `cfg.outcomes.length == 0` while `cfg.enabled == true` is
 *             unreachable. The harness exposes `harness_clearGameOutcomes`.
 *
 *           - `directBetMaxPayout[requestId]` is always set to a positive value
 *             during placement (see `_placeDirectBetInternal`), so the
 *             `maxPayout == 0` fallback in `fulfillRandomness` is unreachable.
 *             The harness exposes `harness_clearMaxPayout`.
 *
 *           - `_updateProgression` is only called by `_handleOutcome` inside
 *             the `isCurrentTierAward` branch (which requires
 *             `outcome.awardsTier == true`), so the `if (!outcome.awardsTier)`
 *             early-return inside `_updateProgression` is unreachable. The
 *             harness exposes `harness_updateProgression`.
 *
 *         NEVER deploy on a non-test network.
 */
contract ProgressiveJackpotHarness is ProgressiveJackpot {
    constructor(address token, address provider, address authHub)
        ProgressiveJackpot(token, provider, authHub)
    {}

    /// @notice Erase the outcomes array for a registered, enabled game so
    ///         processJackpotEntry hits the `outcomes.length == 0` revert.
    function harness_clearGameOutcomes(address game) external {
        delete gameConfigs[game].outcomes;
    }

    /// @notice Zero out the recorded maxPayout for a pending direct bet so the
    ///         fulfillment path falls back to `_computeMaxDirectBetPayout`.
    function harness_clearMaxPayout(uint256 requestId) external {
        delete directBetMaxPayout[requestId];
    }

    /// @notice Call the internal `_updateProgression` directly so tests can
    ///         pass an outcome with `awardsTier == false` and hit the early
    ///         return.
    function harness_updateProgression(uint8 currentTier, OutcomeConfig calldata outcome) external {
        _updateProgression(jackpotState, currentTier, outcome);
    }
}
