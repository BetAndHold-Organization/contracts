// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IAuthHub} from "../interfaces/auth/IAuthHub.sol";

/**
 * @title AuthHub
 * @notice Single source of truth for platform-level authorization state. Holds:
 *
 *           1. Player session keys (player-managed)
 *              - Each player authorizes one ephemeral session key with optional expiration
 *                AND optional cumulative spend cap.
 *              - The session key signs game-specific actions off-chain (e.g. placeBetFor).
 *              - Players authorize directly OR an operator submits a player-signed authorization.
 *
 *           2. Operator allowlist (admin-managed)
 *              - Addresses that may relay signed actions on-chain.
 *              - Compromise of an operator key is bounded: signed actions still require valid
 *                deadlines, nonces, session-key signatures, AND must stay within spend cap.
 *
 *           3. Spend tracker allowlist (admin-managed)
 *              - Game contracts authorized to call recordSpending against player caps.
 *              - Each game with a delegated entry function must be added here.
 *
 *           4. Maximum expiration delta (admin-managed)
 *              - Optional ceiling on how far into the future a player can set expiresAt.
 *              - 0 = unlimited (player may choose any expiry, including never expires).
 *              - >0 = silently clamps long expirations + rejects "never expires" authorizations.
 */
contract AuthHub is IAuthHub, Ownable2Step, EIP712 {
    using ECDSA for bytes32;

    // ═══════════════════════════════════════════════════════════════════════
    //                              ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error InvalidSessionKey();
    error InvalidExpiry();
    error NoSessionKey();
    error InvalidPlayer();
    error InvalidSignature();
    error ExpiredDeadline();
    error InvalidNonce();
    error NotSpendTracker();
    error SpendCapExceeded(uint256 attempted, uint256 cap);

    // ═══════════════════════════════════════════════════════════════════════
    //                              STORAGE
    // ═══════════════════════════════════════════════════════════════════════

    struct KeyAuth {
        address sessionKey;  // address(0) means unset
        uint64 expiresAt;    // 0 means never expires (unless maxExpirationDelta clamps it)
        uint128 spendCap;    // 0 means unlimited; otherwise: max cumulative spent allowed
        uint128 spent;       // cumulative spent under the current authorization; resets on re-authorize
    }

    /// @notice Player → authorized session key + cap state.
    mapping(address => KeyAuth) public keys;

    /// @notice Address → operator allowlist status (relayers for signed actions).
    mapping(address => bool) public override isOperator;

    /// @notice Address → spend-tracker allowlist (games allowed to call recordSpending).
    mapping(address => bool) public spendTrackers;

    /// @notice Per-player nonce for the meta-tx authorize flow (replay protection).
    mapping(address => uint256) public authNonces;

    /// @notice Optional admin-set ceiling on expiresAt. 0 = no ceiling.
    /// @dev    When > 0, any expiresAt = 0 (never) or expiresAt > now + delta is clamped to now + delta.
    uint64 public maxExpirationDelta;

    // ═══════════════════════════════════════════════════════════════════════
    //                              EIP-712
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev EIP-712 typehash for the meta-tx authorize flow.
    bytes32 public constant AUTHORIZE_TYPEHASH = keccak256(
        "Authorize(address player,address sessionKey,uint64 expiresAt,uint128 spendCap,uint256 nonce,uint256 deadline)"
    );

    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event SessionKeyAuthorized(
        address indexed player,
        address indexed sessionKey,
        uint64 expiresAt,
        uint128 spendCap
    );
    event SessionKeyRevoked(address indexed player, address indexed sessionKey);
    event SpendingRecorded(address indexed player, address indexed game, uint256 amount, uint128 newSpent);
    event OperatorSet(address indexed operator, bool status);
    event SpendTrackerSet(address indexed game, bool status);
    event MaxExpirationDeltaSet(uint64 delta);

    constructor() EIP712("BurningGamesAuthHub", "1") {}

    // ═══════════════════════════════════════════════════════════════════════
    //                              PLAYER-CALLABLE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Authorize a session key for the caller. Replaces any existing authorization
    ///         AND resets the spent counter to zero.
    /// @param sessionKey The session key address. Cannot be zero or the player's own address.
    /// @param expiresAt  Unix timestamp at which the key expires. 0 = never (subject to maxExpirationDelta).
    /// @param spendCap   Cumulative spend cap (in token wei). 0 = unlimited.
    function authorize(address sessionKey, uint64 expiresAt, uint128 spendCap) external {
        _setKey(msg.sender, sessionKey, expiresAt, spendCap);
    }

    /// @notice Revoke the caller's session key.
    function revoke() external {
        address oldKey = keys[msg.sender].sessionKey;
        if (oldKey == address(0)) revert NoSessionKey();
        delete keys[msg.sender];
        emit SessionKeyRevoked(msg.sender, oldKey);
    }

    /// @notice Operator-relayed authorize. Player signs the authorization off-chain; operator
    ///         submits it on-chain (gas-free onboarding for first-time users).
    /// @dev    Signature is EIP-712 over (player, sessionKey, expiresAt, spendCap, nonce, deadline).
    function authorizeFor(
        address player,
        address sessionKey,
        uint64 expiresAt,
        uint128 spendCap,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert ExpiredDeadline();
        if (nonce != authNonces[player]) revert InvalidNonce();

        bytes32 structHash = keccak256(abi.encode(
            AUTHORIZE_TYPEHASH, player, sessionKey, expiresAt, spendCap, nonce, deadline
        ));
        address signer = _hashTypedDataV4(structHash).recover(signature);
        if (signer != player) revert InvalidSignature();

        unchecked { authNonces[player] = nonce + 1; }
        _setKey(player, sessionKey, expiresAt, spendCap);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Add or remove an operator address. Operators may relay signed actions on any game.
    function setOperator(address op, bool status) external onlyOwner {
        require(op != address(0), "Invalid operator");
        isOperator[op] = status;
        emit OperatorSet(op, status);
    }

    /// @notice Batch helper for operator management.
    function setOperators(address[] calldata ops, bool status) external onlyOwner {
        for (uint256 i = 0; i < ops.length; i++) {
            require(ops[i] != address(0), "Invalid operator");
            isOperator[ops[i]] = status;
            emit OperatorSet(ops[i], status);
        }
    }

    /// @notice Add or remove a game from the spend-tracker allowlist. Trackers may call recordSpending.
    function setSpendTracker(address game, bool status) external onlyOwner {
        require(game != address(0), "Invalid game");
        spendTrackers[game] = status;
        emit SpendTrackerSet(game, status);
    }

    /// @notice Batch helper for spend-tracker management.
    function setSpendTrackers(address[] calldata games, bool status) external onlyOwner {
        for (uint256 i = 0; i < games.length; i++) {
            require(games[i] != address(0), "Invalid game");
            spendTrackers[games[i]] = status;
            emit SpendTrackerSet(games[i], status);
        }
    }

    /// @notice Set the platform-wide cap on session-key expiration window. 0 disables the cap.
    /// @dev    Affects only future authorize calls; existing keys keep their stored expiresAt.
    function setMaxExpirationDelta(uint64 delta) external onlyOwner {
        maxExpirationDelta = delta;
        emit MaxExpirationDeltaSet(delta);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              GAME-CALLABLE
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IAuthHub
    function recordSpending(address player, uint256 amount) external override {
        if (!spendTrackers[msg.sender]) revert NotSpendTracker();
        KeyAuth storage k = keys[player];
        // Unlimited cap → cheap early return
        if (k.spendCap == 0) return;

        uint256 newSpent = uint256(k.spent) + amount;
        if (newSpent > k.spendCap) revert SpendCapExceeded(newSpent, k.spendCap);

        k.spent = uint128(newSpent);
        emit SpendingRecorded(player, msg.sender, amount, k.spent);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              VIEW
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IAuthHub
    function sessionKeyOf(address player) external view override returns (address) {
        KeyAuth memory ka = keys[player];
        if (ka.expiresAt != 0 && block.timestamp >= ka.expiresAt) {
            return address(0);
        }
        return ka.sessionKey;
    }

    /// @notice Remaining spend budget for the player. Returns type(uint256).max for unlimited.
    function remainingSpend(address player) external view returns (uint256) {
        KeyAuth memory ka = keys[player];
        if (ka.spendCap == 0) return type(uint256).max;
        if (ka.spent >= ka.spendCap) return 0;
        return uint256(ka.spendCap) - uint256(ka.spent);
    }

    /// @notice The EIP-712 domain separator (exposed for off-chain signing tooling).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              INTERNAL
    // ═══════════════════════════════════════════════════════════════════════

    function _setKey(address player, address sessionKey, uint64 expiresAt, uint128 spendCap) internal {
        if (player == address(0)) revert InvalidPlayer();
        if (sessionKey == address(0) || sessionKey == player) revert InvalidSessionKey();

        // Apply admin ceiling on expiration. 0 (never) becomes the cap when a cap exists.
        uint64 maxDelta = maxExpirationDelta;
        if (maxDelta > 0) {
            uint64 maxAllowed = uint64(block.timestamp) + maxDelta;
            if (expiresAt == 0 || expiresAt > maxAllowed) {
                expiresAt = maxAllowed;
            }
        }

        // Past or "now" expirations are nonsense for a fresh authorization.
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidExpiry();

        // Reset model: re-authorizing always restarts the spent counter.
        keys[player] = KeyAuth({
            sessionKey: sessionKey,
            expiresAt: expiresAt,
            spendCap: spendCap,
            spent: 0
        });

        emit SessionKeyAuthorized(player, sessionKey, expiresAt, spendCap);
    }
}
