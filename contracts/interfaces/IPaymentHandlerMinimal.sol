// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

interface IPaymentHandlerMinimal {
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
            uint16 referralBps
        );
}
