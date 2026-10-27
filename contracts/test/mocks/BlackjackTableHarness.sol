// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {BlackjackTableLib} from "../../games/blackjack/libraries/BlackjackTableLib.sol";

/// @dev Test-only: exposes the pure table replay (golden vectors, engine tests).
contract BlackjackTableHarness {
    function replayTable(
        bytes32 seed,
        BlackjackTableLib.SeatInput[] calldata inputs,
        bytes[] calldata actions
    ) external pure returns (BlackjackTableLib.Result memory) {
        return BlackjackTableLib.play(seed, inputs, actions);
    }
}
