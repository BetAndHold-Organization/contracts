// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {BaseGame} from "./base/BaseGame.sol";

/**
 * @title PaymentOnlyGameAdapter
 * @notice Minimal game adapter for off-chain games. Handles bet collection and
 *         payment processing through the BaseGame primitives. Game logic and
 *         winner determination happen off-chain; payouts are triggered by the owner.
 */
contract PaymentOnlyGameAdapter is BaseGame {

    event GamePlayed(address indexed player, uint256 amountPaid, uint256 netAmount, address potentialReferrer, bytes32 gameId);
    event WinnerPaid(address indexed player, uint256 amount);

    constructor(address _token, address _handler)
        BaseGame(_token, _handler)
    {}

    function play(uint256 amount, address potentialReferrer, bytes32 gameId) external nonReentrant {
        require(amount > 0, "amount=0");
        uint256 netAmount = _collectAndProcessBet(msg.sender, potentialReferrer, amount);
        emit GamePlayed(msg.sender, amount, netAmount, potentialReferrer, gameId);
    }

    function payWinner(address player, uint256 amount) external onlyOwner nonReentrant {
        require(player != address(0), "bad player");
        require(amount > 0, "amount=0");
        _payPlayer(player, amount);
        emit WinnerPaid(player, amount);
    }

    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "bad to");
        _payPlayer(to, amount);
    }
}
