// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPaymentHandler {
    function processDirectBetFromGame(address bettor, address potentialReferrer, uint256 baseCost)
        external
        returns (uint256 netAmount);
}

/// @notice Lightweight game stub that forwards bets to the PaymentHandler and
///         records the net amount it receives. Useful for isolating handler
///         behaviour without pulling in full jackpot logic.
contract MockPaymentGame {
    IPaymentHandler public immutable handler;
    IERC20 public immutable token;

    uint256 public totalReceived;
    uint256 public lastNetAmount;
    address public lastBettor;

    event BetForwarded(address indexed bettor, address indexed potentialReferrer, uint256 baseCost, uint256 netAmount);

    constructor(address handler_, address token_) {
        handler = IPaymentHandler(handler_);
        token = IERC20(token_);
    }

    function placeBet(address bettor, address potentialReferrer, uint256 baseCost)
        external
        returns (uint256 netAmount)
    {
        netAmount = handler.processDirectBetFromGame(bettor, potentialReferrer, baseCost);
        totalReceived += netAmount;
        lastNetAmount = netAmount;
        lastBettor = bettor;
        emit BetForwarded(bettor, potentialReferrer, baseCost, netAmount);
    }

    function tokenBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}











