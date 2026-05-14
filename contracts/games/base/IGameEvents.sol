// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

/**
 * @title IGameEvents
 * @notice Standardized event envelope every Burning Games game must emit.
 *
 *         Three events describe the full bet lifecycle. Game-specific payload
 *         (outcome details, grid, slots, click history, etc.) goes in the
 *         `data` blob — ABI-encoded with a per-game schema documented on the
 *         emitting contract. The envelope (requestId, player, amount, payout,
 *         reason) is fixed so indexers and dashboards can rely on the same
 *         shape across every game and every redeploy.
 *
 *         A game inheriting one of the shape bases (PushVRFGame, PullVRFGame,
 *         OperatorGame) gets these events automatically. Game-specific events
 *         (SpinResolved, GameClaimed, etc.) MAY exist alongside but the three
 *         events here are the canonical lifecycle signal.
 */
abstract contract IGameEvents {
    /// @notice Bet placed. For VRF-driven games, requestId equals the VRF request ID.
    ///         For operator-driven games (lotteries, off-chain games), requestId is
    ///         a game-specific identifier (e.g. round ID, sequence number, hash).
    /// @param requestId Lifecycle identifier — joins BetPlaced / BetSettled / BetFailed.
    /// @param player    Address that placed the bet. For *For calls this is the player,
    ///                  NOT the operator who relayed.
    /// @param amount    Total amount staked, gross (before any fees deducted by handler).
    /// @param data      ABI-encoded game-specific metadata (schema is per-game).
    event BetPlaced(
        uint256 indexed requestId,
        address indexed player,
        uint256 amount,
        bytes data
    );

    /// @notice Bet resolved. `payout` is the amount actually transferred to the player
    ///         (0 = lose, > 0 = win). Game-specific outcome details live in `data`.
    event BetSettled(
        uint256 indexed requestId,
        address indexed player,
        uint256 payout,
        bytes data
    );

    /// @notice Bet failed before resolution (VRF timeout, oracle unreachable, etc.).
    ///         Whether tokens were refunded is game-policy — `reason` should encode it.
    /// @param reason A bytes32 tag identifying the failure mode (e.g. "VRF_TIMEOUT").
    event BetFailed(
        uint256 indexed requestId,
        address indexed player,
        bytes32 reason
    );
}
