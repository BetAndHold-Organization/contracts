// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

/**
 * @title IAuthHub
 * @notice Interface games and the SignedActionAuth mixin use to query and mutate the AuthHub.
 *
 *         State spaces:
 *           - sessionKeyOf(player): per-player ephemeral key authorized by the player itself
 *           - isOperator(addr): admin-managed allowlist of relayer addresses
 *
 *         State-changing surface used by games:
 *           - recordSpending(player, amount): tracker-only call from games' delegated entries
 *             that increments the player's spent counter (and reverts if the cap is hit)
 */
interface IAuthHub {
    /// @notice Resolves the active session key for a player. Returns address(0) if unset or expired.
    function sessionKeyOf(address player) external view returns (address);

    /// @notice Whether the address is on the operator allowlist (allowed to relay signed actions).
    function isOperator(address addr) external view returns (bool);

    /**
     * @notice Record bet spending against a player's session-key cap.
     * @dev    Caller must be a whitelisted spend tracker. No-op when the player has spendCap = 0
     *         (unlimited). Reverts if the bet would push the player's cumulative spent past their cap.
     */
    function recordSpending(address player, uint256 amount) external;
}
