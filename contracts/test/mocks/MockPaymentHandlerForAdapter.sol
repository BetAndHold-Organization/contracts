// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

contract MockPaymentHandlerForAdapter {
    address public lastBettor;
    address public lastReferrer;
    uint256 public lastBaseCost;
    uint256 public netAmountReturn;

    event Processed(address indexed bettor, address indexed referrer, uint256 baseCost, uint256 netAmount);

    function setNetAmount(uint256 netAmount) external {
        netAmountReturn = netAmount;
    }

    function processDirectBetFromGame(address bettor, address potentialReferrer, uint256 baseCost)
        external
        returns (uint256 netAmount)
    {
        lastBettor = bettor;
        lastReferrer = potentialReferrer;
        lastBaseCost = baseCost;
        netAmount = netAmountReturn;
        emit Processed(bettor, potentialReferrer, baseCost, netAmount);
    }

    function getGameConfig(address)
        external
        pure
        returns (bool enabled, address payoutTarget, address feeRecipient, uint16 houseEdgeBps, uint16 referralBps)
    {
        return (true, address(0), address(0), 0, 0);
    }
}






