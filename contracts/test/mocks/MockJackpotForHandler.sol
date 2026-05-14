// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Minimal jackpot stand-in for PaymentHandler unit tests.
///      Implements `addFunds(uint256)` and actually pulls the tokens via transferFrom,
///      so tests cover PaymentHandler's standing approval + token-flow behaviour.
contract MockJackpotForHandler {
    IERC20 public immutable token;

    address public lastCaller;
    uint256 public lastAmount;
    uint256 public callCount;
    uint256 public totalReceived;

    /// @dev When true, addFunds reverts. Used to test failure paths.
    bool public shouldRevert;

    constructor(address _token) {
        token = IERC20(_token);
    }

    function setShouldRevert(bool flag) external {
        shouldRevert = flag;
    }

    function addFunds(uint256 amount) external {
        require(!shouldRevert, "MockJackpot: forced revert");
        lastCaller = msg.sender;
        lastAmount = amount;
        callCount += 1;
        totalReceived += amount;
        require(token.transferFrom(msg.sender, address(this), amount), "MockJackpot: transferFrom failed");
    }
}
