// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title MerkleClaimLib
 * @notice Library for Merkle proof verification for MANUAL mode claims
 * @dev Uses OpenZeppelin's MerkleProof library for audited, gas-efficient verification
 *
 * ## Merkle Tree Structure
 * Each leaf in the tree represents a valid cashout:
 * leaf = keccak256(bytes.concat(keccak256(abi.encode(roundId, player, betId, cashoutMultiplier, payout))))
 *
 * The backend builds the tree from all valid cashout intents received before crash.
 * Uses double-hashing (StandardMerkleTree format) to prevent second preimage attacks.
 */
library MerkleClaimLib {
    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error InvalidMerkleProof();
    error MerkleRootNotSet();

    // ═══════════════════════════════════════════════════════════════════════════
    // FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Compute the leaf hash for a cashout claim
     * @param roundId The round ID
     * @param player The player address
     * @param betId The bet ID
     * @param cashoutMultiplier The multiplier at which player cashed out (in bps)
     * @param payout The calculated payout amount
     * @return leaf The leaf hash
     * @dev Uses double-hashing to match OpenZeppelin's StandardMerkleTree format
     */
    function computeLeaf(
        uint256 roundId,
        address player,
        uint256 betId,
        uint32 cashoutMultiplier,
        uint256 payout
    ) internal pure returns (bytes32 leaf) {
        // Double hash to prevent second preimage attacks
        // This matches @openzeppelin/merkle-tree StandardMerkleTree format
        leaf = keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(roundId, player, betId, cashoutMultiplier, payout)
                )
            )
        );
    }

    /**
     * @notice Verify a Merkle proof for a cashout claim
     * @param proof The Merkle proof (array of sibling hashes)
     * @param root The Merkle root stored on-chain
     * @param leaf The leaf hash being verified
     * @return valid True if the proof is valid
     * @dev Uses OpenZeppelin's MerkleProof.verify for audited verification
     */
    function verifyProof(
        bytes32[] calldata proof,
        bytes32 root,
        bytes32 leaf
    ) internal pure returns (bool valid) {
        if (root == bytes32(0)) {
            revert MerkleRootNotSet();
        }

        valid = MerkleProof.verify(proof, root, leaf);
    }

    /**
     * @notice Verify and revert if invalid
     * @param proof The Merkle proof
     * @param root The Merkle root
     * @param leaf The leaf hash
     */
    function verifyProofOrRevert(
        bytes32[] calldata proof,
        bytes32 root,
        bytes32 leaf
    ) internal pure {
        if (!verifyProof(proof, root, leaf)) {
            revert InvalidMerkleProof();
        }
    }

    /**
     * @notice Verify a cashout claim with full parameters
     * @param proof The Merkle proof
     * @param root The Merkle root
     * @param roundId The round ID
     * @param player The player address
     * @param betId The bet ID
     * @param cashoutMultiplier The cashout multiplier
     * @param payout The payout amount
     * @return valid True if the claim is valid
     */
    function verifyCashoutClaim(
        bytes32[] calldata proof,
        bytes32 root,
        uint256 roundId,
        address player,
        uint256 betId,
        uint32 cashoutMultiplier,
        uint256 payout
    ) internal pure returns (bool valid) {
        bytes32 leaf = computeLeaf(roundId, player, betId, cashoutMultiplier, payout);
        valid = verifyProof(proof, root, leaf);
    }
}

