// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {BaseGame} from "./BaseGame.sol";
import {IRandomConsumer} from "../interfaces/IRandomConsumer.sol";
import {IRandomProviderMinimal} from "../interfaces/IRandomProviderMinimal.sol";

/**
 * @title VRFGameBase
 * @notice Extends BaseGame with Chainlink VRF random provider plumbing.
 *         Games that need on-chain randomness inherit this instead of BaseGame directly.
 */
abstract contract VRFGameBase is BaseGame, IRandomConsumer {

    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════

    IRandomProviderMinimal public immutable randomProvider;

    // ═══════════════════════════════════════════════════════════════════════
    //                              ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error UnauthorizedCaller();

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(address token, address handler, address provider)
        BaseGame(token, handler)
    {
        require(provider != address(0), "Invalid provider");
        randomProvider = IRandomProviderMinimal(provider);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════

    modifier onlyRandomProvider() {
        if (msg.sender != address(randomProvider)) revert UnauthorizedCaller();
        _;
    }
}
