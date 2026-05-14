// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {OperatorGame} from "./base/OperatorGame.sol";

/**
 * @title PaymentOnlyGameAdapter
 * @notice Minimal game adapter for off-chain games on the OperatorGame canonical base.
 *         Handles bet collection and payment processing through BaseGame primitives.
 *         Game logic and winner determination happen off-chain; payouts are triggered
 *         by an allowlisted game operator (so the cold owner key isn't required for
 *         every payout).
 */
contract PaymentOnlyGameAdapter is OperatorGame {

    bytes32 public constant PLAY_TYPEHASH = keccak256(
        "Play(address game,address player,uint256 amount,address potentialReferrer,bytes32 gameId,uint256 nonce,uint256 deadline)"
    );

    event GamePlayed(address indexed player, uint256 amountPaid, uint256 netAmount, address potentialReferrer, bytes32 gameId);
    event WinnerPaid(address indexed player, uint256 amount);

    /// @notice Sequential bet identifier — increments per play() call. Used as the
    ///         `requestId` in the IGameEvents.BetPlaced envelope.
    /// @dev    Off-chain settlement is independent of this id; payWinner does NOT emit
    ///         BetSettled because the payout isn't bet-linked.
    uint256 public nextBetId;

    constructor(address _token, address _handler, address authHub, address initialOperator)
        OperatorGame(_token, _handler, authHub, "PaymentOnlyGameAdapter", "1", initialOperator)
    {}

    function play(uint256 amount, address potentialReferrer, bytes32 gameId) external nonReentrant {
        _playInternal(msg.sender, amount, potentialReferrer, gameId);
    }

    function playFor(
        address player,
        uint256 amount,
        address potentialReferrer,
        bytes32 gameId,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOperator nonReentrant {
        bytes32 structHash = keccak256(
            abi.encode(
                PLAY_TYPEHASH,
                address(this),
                player,
                amount,
                potentialReferrer,
                gameId,
                nonce,
                deadline
            )
        );
        _verifyAndConsume(player, address(this), amount, structHash, deadline, nonce, signature);
        _playInternal(player, amount, potentialReferrer, gameId);
    }

    function _playInternal(address player, uint256 amount, address potentialReferrer, bytes32 gameId) internal {
        require(amount > 0, "amount=0");
        uint256 netAmount = _collectAndProcessBet(player, potentialReferrer, amount);
        uint256 betId = ++nextBetId;
        emit GamePlayed(player, amount, netAmount, potentialReferrer, gameId);
        // Standard envelope (IGameEvents). data = abi.encode(netAmount, potentialReferrer, gameId)
        emit BetPlaced(betId, player, amount, abi.encode(netAmount, potentialReferrer, gameId));
    }

    function payWinner(address player, uint256 amount) external onlyGameOperator nonReentrant {
        require(player != address(0), "bad player");
        require(amount > 0, "amount=0");
        _payPlayer(player, amount);
        emit WinnerPaid(player, amount);
    }

    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "bad to");
        _payPlayer(to, amount);
    }

    // setGameOperator / setGameOperators inherited from OperatorGame.
}
