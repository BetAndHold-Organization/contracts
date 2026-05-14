// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IProgressiveJackpot {
    function addFunds(uint256 amount) external;

    function processJackpotEntry(
        address player,
        uint256 betAmount,
        uint256 roll
    ) external returns (uint256 payout);
}

/// @notice Minimal harness that exercises the ProgressiveJackpot surface
///         exactly like a registered game. Keeps dependencies lightweight for tests.
contract MockGameHarness {
    IProgressiveJackpot public immutable jackpot;
    IERC20 public immutable token;

    constructor(address jackpot_, address token_) {
        jackpot = IProgressiveJackpot(jackpot_);
        token = IERC20(token_);
    }

    /// @notice Pull tokens from the caller, approve the jackpot, and add funds
    ///         to mimic the game funding path.
    function contribute(uint256 amount) external {
        require(amount > 0, "amount == 0");

        token.transferFrom(msg.sender, address(this), amount);
        token.approve(address(jackpot), amount);
        jackpot.addFunds(amount);
    }

    function contributeRaw(uint256 amount) external {
        jackpot.addFunds(amount);
    }

    function forwardEntry(
        address player,
        uint256 betAmount,
        uint256 roll
    ) external returns (uint256 payout) {
        return jackpot.processJackpotEntry(player, betAmount, roll);
    }

    /// @notice Forward a jackpot entry with the caller-specified roll.
    function submitEntry(
        address player,
        uint256 betAmount,
        uint256 roll
    ) external returns (uint256 payout) {
        return jackpot.processJackpotEntry(player, betAmount, roll);
    }
}


