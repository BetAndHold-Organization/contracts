// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IPaymentHandlerMinimal {
    function processDirectBetFromGame(address bettor, address potentialReferrer, uint256 baseCost)
        external
        returns (uint256 netAmount);
    function getGameConfig(address game)
        external
        view
        returns (bool enabled, address payoutTarget, address feeRecipient, uint16 houseEdgeBps, uint16 referralBps);
}

contract PaymentOnlyGameAdapter {
    IERC20 public immutable token;
    IPaymentHandlerMinimal public immutable handler;
    address public owner;

    event GamePlayed(address indexed player, uint256 amountPaid, uint256 netAmount, address potentialReferrer, bytes32 gameId);
    event WinnerPaid(address indexed player, uint256 amount);
    event OwnerUpdated(address indexed newOwner);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _token, address _handler) {
        require(_token != address(0) && _handler != address(0), "bad addr");
        token = IERC20(_token);
        handler = IPaymentHandlerMinimal(_handler);
        owner = msg.sender;
    }

    function play(uint256 amount, address potentialReferrer, bytes32 gameId) external {
        require(amount > 0, "amount=0");
        uint256 netAmount = handler.processDirectBetFromGame(msg.sender, potentialReferrer, amount);
        emit GamePlayed(msg.sender, amount, netAmount, potentialReferrer, gameId);
    }

    function payWinner(address player, uint256 amount) external onlyOwner {
        require(player != address(0), "bad player");
        require(amount > 0, "amount=0");
        require(token.transfer(player, amount), "transfer failed");
        emit WinnerPaid(player, amount);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "bad to");
        require(token.transfer(to, amount), "withdraw failed");
    }

    function setOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "bad owner");
        owner = newOwner;
        emit OwnerUpdated(newOwner);
    }
}