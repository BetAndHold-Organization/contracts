// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

import {GameLifecycleRoles} from "../../games/base/GameLifecycleRoles.sol";

/// @dev Minimal harness for exercising GameLifecycleRoles in isolation.
///      Mirrors how production games wrap _setGameOperator behind onlyOwner.
contract GameLifecycleRolesHarness is Ownable2Step, GameLifecycleRoles {
    event Pinged(address indexed caller);

    function setGameOperator(address operator, bool status) external onlyOwner {
        _setGameOperator(operator, status);
    }

    function setGameOperators(address[] calldata operators, bool status) external onlyOwner {
        for (uint256 i = 0; i < operators.length; i++) {
            _setGameOperator(operators[i], status);
        }
    }

    /// @notice Function that requires the caller to be a game operator.
    function operatorOnly() external onlyGameOperator {
        emit Pinged(msg.sender);
    }
}
