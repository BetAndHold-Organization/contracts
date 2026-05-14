// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/**
 * @title IPaymentHandlerMinimal
 * @notice Canonical interface every game uses to interact with PaymentHandler.
 *         New games MUST import this — see GAME_AUTHOR_GUIDE for the rule.
 *
 *         The interface is intentionally minimal but covers everything an
 *         on-platform game has needed so far: bet routing, fee discovery,
 *         jackpot lookup, EVA token discovery, and the player blacklist.
 *         If you find yourself wanting to declare a second `IPaymentHandler*`
 *         in your game folder, extend this interface instead.
 */
interface IPaymentHandlerMinimal {
    /// @notice Route a player's bet through the handler. Pulls `baseCost` from
    ///         the caller (= the game), deducts house/referral/jackpot fees,
    ///         and returns the net stake the game keeps.
    function processDirectBetFromGame(address bettor, address potentialReferrer, uint256 baseCost)
        external
        returns (uint256 netAmount);

    function getGameConfig(address game)
        external
        view
        returns (
            bool enabled,
            address payoutTarget,
            address feeRecipient,
            uint16 houseEdgeBps,
            uint16 referralBps,
            uint16 jackpotBps
        );

    /// @notice Address of the platform-wide jackpot that PaymentHandler routes contributions to.
    function getJackpot() external view returns (address);

    /// @notice Sum of houseEdgeBps + referralBps + jackpotBps for the given game.
    function getTotalDeductionBps(address game) external view returns (uint16);

    /// @notice MAX_BPS - getTotalDeductionBps(game). The fraction of the bet that reaches the game's bankroll.
    function getNetStakeBps(address game) external view returns (uint16);

    /// @notice The EVA token address used for all bet flows.
    function evaToken() external view returns (address);

    /// @notice Platform-wide player blacklist. Returns true if the player
    ///         is banned from interacting with games via PaymentHandler.
    function blacklist(address player) external view returns (bool);
}
