// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title GameLifecycleRoles
 * @notice Per-game operator allowlist for game-specific lifecycle operations
 *         (e.g. CrashGame's createRound / revealSeed / submitMerkleRoot,
 *         Mines's resolveAbandoned / cancelExpired, ECDSA attestations for
 *         player-driven claim paths, etc.).
 *
 *         This is intentionally separate from the platform-wide AuthHub:
 *           - AuthHub.isOperator → who may relay player-signed actions
 *             (used by SignedActionAuth.onlyOperator)
 *           - gameOperators[addr] → who may run THIS game's lifecycle AND
 *             whose ECDSA signatures the game accepts as attestations
 *             (used by onlyGameOperator + _verifyOperatorAttestation)
 *
 *         The same operational backend address is typically authorized in both
 *         lists, but they are managed independently — compromise or rotation
 *         of one does not affect the other.
 *
 *         Games that want a split between "signs attestations" and "submits
 *         lifecycle txs" simply register two operator addresses (e.g. cold
 *         signing key + hot tx-submission key). The contract treats both
 *         identically; operational practice keeps them separated.
 *
 * @dev Inheriting contract wraps `_setGameOperator` with its own access control
 *      (e.g. Ownable2Step's onlyOwner) to expose a public setter.
 */
abstract contract GameLifecycleRoles {
    using ECDSA for bytes32;

    error NotGameOperator();

    mapping(address => bool) public gameOperators;

    event GameOperatorSet(address indexed operator, bool status);

    modifier onlyGameOperator() {
        if (!gameOperators[msg.sender]) revert NotGameOperator();
        _;
    }

    /// @dev Internal setter. Inheriting contract gates the public entry with its own access control.
    function _setGameOperator(address operator, bool status) internal {
        require(operator != address(0), "Invalid operator");
        gameOperators[operator] = status;
        emit GameOperatorSet(operator, status);
    }

    /**
     * @notice Verify an ECDSA signature over `toEthSignedMessageHash(messageHash)` was
     *         produced by an address on the gameOperators allowlist.
     * @dev    Standard helper for games that accept off-chain operator attestations
     *         (e.g. Mines's click-outcome signatures). Uses the legacy ETH-signed-message
     *         hash so signers can produce the signature with standard `personal_sign`
     *         tooling — no EIP-712 typed data required.
     *
     *         For EIP-712 player-signed actions (placeBetFor etc.) use
     *         SignedActionAuth._verifyAndConsume instead — that's a separate path with
     *         player session keys, not operator attestations.
     *
     * @param messageHash The keccak256 of the data being attested. The function applies
     *                    `toEthSignedMessageHash` internally before recovery.
     * @param signature   65-byte ECDSA signature in `(r, s, v)` form.
     * @return signer     The recovered address (already verified to be on the allowlist).
     *
     *         Reverts NotGameOperator if the recovered signer is not allowlisted.
     */
    function _verifyOperatorAttestation(bytes32 messageHash, bytes calldata signature)
        internal
        view
        returns (address signer)
    {
        signer = messageHash.toEthSignedMessageHash().recover(signature);
        if (!gameOperators[signer]) revert NotGameOperator();
    }
}
