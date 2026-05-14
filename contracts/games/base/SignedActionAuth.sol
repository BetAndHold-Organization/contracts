// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IAuthHub} from "../../interfaces/auth/IAuthHub.sol";

/**
 * @title SignedActionAuth
 * @notice Game-side mixin for delegated transactions. Each game inherits this and exposes
 *         relayed entries (e.g. placeBetFor) that:
 *           1. Are submitted by an operator authorized in the AuthHub.
 *           2. Carry an EIP-712 signature from the player's session key (read from AuthHub).
 *           3. Bind explicitly to THIS game contract (defense-in-depth against cross-contract replay).
 *           4. Charge the player's session-key spend cap on AuthHub before proceeding.
 *
 *         The mixin does not store session keys, operator state, or spend caps — those live in
 *         the AuthHub singleton so a single sign-up (or operator rotation) covers every game.
 *         What stays local: this game's EIP-712 domain and per-player action nonce.
 *
 * @dev    Inheriting contract supplies its own EIP-712 (name, version) so the wallet popup
 *         shows the game name when the user signs. Per-game nonces keep games independent —
 *         a signed action for Crash cannot replay on Roulette even before the game-binding check.
 */
abstract contract SignedActionAuth is EIP712 {
    using ECDSA for bytes32;

    // ═══════════════════════════════════════════════════════════════════════
    //                              ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error NotOperator();
    error WrongGame(address expected, address provided);
    error ExpiredDeadline();
    error InvalidNonce();
    error NoSessionKey();
    error InvalidSignature();

    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Platform-wide auth registry. Immutable per game contract.
    IAuthHub public immutable authHub;

    /// @notice Per-player action nonce. Local to this game; not shared across games.
    mapping(address => uint256) public actionNonces;

    constructor(string memory eip712Name, string memory eip712Version, address authHub_)
        EIP712(eip712Name, eip712Version)
    {
        require(authHub_ != address(0), "Invalid auth hub");
        authHub = IAuthHub(authHub_);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Restricts a function to relayer addresses on the AuthHub allowlist.
    modifier onlyOperator() {
        if (!authHub.isOperator(msg.sender)) revert NotOperator();
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              VIEW
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice The EIP-712 domain separator for this game (exposed for off-chain signing tooling).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Convenience view for off-chain quoting of next nonce.
    function getActionNonce(address player) external view returns (uint256) {
        return actionNonces[player];
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              INTERNAL
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Verify a player-signed action, charge their spend cap, and consume the nonce.
     * @dev    The inheriting game builds `structHash` over its own typehash + parameters
     *         (which MUST include `address game` as a field), and passes its own address
     *         as `game` here. On success, the player's nonce is incremented and their
     *         spent counter on AuthHub is incremented by `betAmount`.
     *
     * @param player      The bettor whose session key signed the action
     * @param game        Must equal address(this) — defense-in-depth against replay across games
     * @param betAmount   Amount to charge against the player's spend cap (in token wei).
     *                    Pass 0 to skip cap accounting (e.g. for actions with no monetary value).
     * @param structHash  EIP-712 struct hash over the game's typehash + parameters
     * @param deadline    Signature expiration timestamp
     * @param nonce       Expected per-player action nonce
     * @param signature   EIP-712 signature from the player's session key
     *
     * Reverts on:
     *   - game mismatch (defense in depth)
     *   - expired deadline
     *   - wrong nonce
     *   - player has no session key (or it expired)
     *   - recovered signer is not the player's session key
     *   - spend cap exceeded (when betAmount > 0)
     */
    function _verifyAndConsume(
        address player,
        address game,
        uint256 betAmount,
        bytes32 structHash,
        uint256 deadline,
        uint256 nonce,
        bytes calldata signature
    ) internal {
        if (game != address(this)) revert WrongGame(address(this), game);
        if (block.timestamp > deadline) revert ExpiredDeadline();
        if (nonce != actionNonces[player]) revert InvalidNonce();

        address expectedSigner = authHub.sessionKeyOf(player);
        if (expectedSigner == address(0)) revert NoSessionKey();

        address signer = _hashTypedDataV4(structHash).recover(signature);
        if (signer != expectedSigner) revert InvalidSignature();

        // Charge the player's spend cap. No-op when their cap is unlimited.
        // Reverts here propagate up and roll back the bet entirely (consistent state).
        if (betAmount > 0) {
            authHub.recordSpending(player, betAmount);
        }

        unchecked { actionNonces[player] = nonce + 1; }
    }
}
