// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

interface IProgressiveJackpot {
    function addFunds(uint256 amount) external;
    function processJackpotEntry(address player, uint256 betAmount, uint256 roll) external returns (uint256 payout);
    function PROBABILITY_PRECISION() external view returns (uint256);
    function ensurePayable(address game, uint256 betAmount) external view;
}
