// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

/**
 * @title ICrashGame
 * @notice Interface for the Crash Train game contract
 * @dev Defines the main game functionality for both AUTO and MANUAL modes
 */
interface ICrashGame {
    // ═══════════════════════════════════════════════════════════════════════════
    // ENUMS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Round lifecycle states
     */
    enum RoundState {
        None,           // 0: Round doesn't exist
        Created,        // 1: Round created, operator committed
        Betting,        // 2: Betting window open
        Running,        // 3: VRF requested, train running (no more bets)
        Crashed,        // 4: VRF received, crash point determined
        Revealed,       // 5: Operator revealed server seed
        Settled         // 6: Round fully settled (all claims processed)
    }

    /**
     * @notice Bet modes
     */
    enum BetMode {
        Auto,           // 0: Auto-cashout at specified multiplier
        Manual          // 1: Manual cashout via signature
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Game configuration parameters
     */
    struct GameConfig {
        uint32 roundIntervalSeconds;   // Time between rounds
        uint32 bettingWindowSeconds;   // Duration of betting window
        uint32 revealDeadlineSeconds;  // Time operator has to reveal after crash
        uint32 maxMultiplier;          // Maximum allowed multiplier (e.g., 5000000 = 500.00x)
        uint32 reservationMultiplier;  // Max multiplier for exposure reservation (e.g., 500000 = 50.00x)
        uint256 minBetAmount;          // Minimum bet in wei
        uint256 maxBetAmount;          // Maximum bet in wei
        uint256 maxPayoutPerRound;     // Bankroll safety cap per round
        uint256 operatorBondAmount;    // Required operator bond
        uint32 claimWindowSeconds;     // Time for players to claim MANUAL payouts after reveal
        uint8 maxBetsPerRound;         // Max bets per player per round (0 = unlimited)
    }

    /**
     * @notice Round data
     */
    struct Round {
        uint256 roundId;
        RoundState state;
        bytes32 commitHash;            // keccak256(serverSeed)
        bytes32 serverSeed;            // Revealed after round
        uint256 vrfRequestId;
        uint256 vrfRandomWord;
        uint32 crashPoint;             // In basis points (e.g., 15000 = 1.50x, 100000 = 10.00x)
        uint64 bettingOpensAt;
        uint64 bettingClosesAt;
        uint64 crashedAt;
        uint64 revealDeadline;
        bytes32 merkleRoot;            // For MANUAL mode claims
        uint256 totalBetAmount;
        uint256 totalGrossBetAmount;
        uint256 totalPayoutAmount;
    }

    /**
     * @notice Bet data
     */
    struct Bet {
        address player;
        uint256 roundId;
        uint256 amount;                // Gross bet amount
        uint256 netAmount;             // After PaymentHandler fees
        uint32 autoCashoutMultiplier;  // For AUTO mode (0 = MANUAL)
        BetMode mode;
        bool claimed;
        uint256 payout;
    }

    /**
     * @notice Batch claim request
     * @param betId The bet ID to claim
     * @param cashoutMultiplier For MANUAL bets, the cashout multiplier. Ignored for AUTO bets.
     * @param merkleProof For MANUAL bets, the Merkle proof. Empty for AUTO bets.
     */
    struct ClaimRequest {
        uint256 betId;
        uint32 cashoutMultiplier;
        bytes32[] merkleProof;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════

    event RoundCreated(uint256 indexed roundId, bytes32 commitHash, uint64 bettingOpensAt);
    event RoundBettingOpened(uint256 indexed roundId);
    event RoundRunning(uint256 indexed roundId, uint256 vrfRequestId);
    /// @dev `crashPoint` is 0 here because the value is hidden behind the unrevealed commitment.
    ///      The deterministic crash point is exposed in `RoundRevealed` once the serverSeed lands.
    event RoundCrashed(uint256 indexed roundId, uint32 crashPoint, uint256 vrfRandomWord);
    /// @dev `crashPoint` is the deterministic final multiplier in basis points (e.g. 25000 = 2.50x).
    ///      In refund / emergency paths this is the refund multiplier (1.02x); on the normal path
    ///      it is computed deterministically from (vrfRandomWord, serverSeed, roundId) via
    ///      `CrashMathLib.computeCrashPoint`.
    event RoundRevealed(uint256 indexed roundId, bytes32 serverSeed, uint32 crashPoint);
    /// @notice Fired once per round when the operator settles total claimable payouts.
    /// @param crashPoint     Same value as `RoundRevealed.crashPoint`, duplicated for query convenience.
    /// @param totalBetAmount Sum of net bet amounts placed during the round (already on Round struct).
    /// @param totalPayout    Operator-submitted sum of AUTO + MANUAL payouts the round will distribute.
    event RoundSettled(
        uint256 indexed roundId,
        uint32 crashPoint,
        uint256 totalBetAmount,
        uint256 totalPayout
    );

    event BetPlaced(
        uint256 indexed roundId,
        address indexed player,
        uint256 betId,
        uint256 amount,
        uint256 netAmount,
        BetMode mode,
        uint32 autoCashoutMultiplier
    );

    event PayoutClaimed(
        uint256 indexed roundId,
        address indexed player,
        uint256 betId,
        uint256 payout
    );

    event BatchPayoutClaimed(address indexed player, uint256 totalPayout, uint256 claimCount);

    // Skip reasons: 1=BetNotFound, 2=NotBetOwner, 3=AlreadyClaimed,
    // 4=RoundNotRevealed, 5=ExposureNotSettled, 6=MerkleRootNotSet,
    // 7=InvalidMultiplier, 8=InvalidMerkleProof
    event ClaimSkipped(uint256 indexed betId, uint8 reason);

    // ManualCashoutRecorded was declared here in earlier iterations but never emitted —
    // manual cashouts are recorded off-chain in a merkle tree and verified at claim time
    // via PayoutClaimed. Declaration removed to keep the interface honest.

    event MerkleRootSubmitted(uint256 indexed roundId, bytes32 merkleRoot);

    event UnclaimedExposureExpired(uint256 indexed roundId, uint256 amount);
    // PaymentHandlerUpdated is inherited from BaseGame and fired by the inherited setter.
    event ConfigUpdated(string paramName, uint256 oldValue, uint256 newValue);
    event OperatorBondDeposited(address indexed operator, uint256 amount);
    event OperatorBondWithdrawn(address indexed operator, uint256 amount);
    event PlayerBanned(address indexed player, bool banned);

    // ═══════════════════════════════════════════════════════════════════════════
    // PLAYER FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Place a bet in the current betting round
     * @param amount Bet amount in EVA tokens
     * @param autoCashoutMultiplier For AUTO mode, the target multiplier (e.g., 15000 = 1.50x). 0 for MANUAL mode.
     * @param referrer Optional referrer address
     * @return betId The unique bet ID
     */
    function placeBet(
        uint256 amount,
        uint32 autoCashoutMultiplier,
        address referrer
    ) external returns (uint256 betId);

    /**
     * @notice Place a bet on behalf of a player using a session key signature
     * @param player The player whose tokens will be used
     * @param amount Bet amount in EVA tokens
     * @param autoCashoutMultiplier For AUTO mode (e.g., 15000 = 1.50x). 0 for MANUAL mode.
     * @param referrer Optional referrer address
     * @param nonce Player's current bet nonce (replay protection)
     * @param deadline Timestamp after which the signature expires
     * @param signature EIP-712 signature from the player's session key
     * @return betId The unique bet ID
     */
    function placeBetFor(
        address player,
        uint256 amount,
        uint32 autoCashoutMultiplier,
        address referrer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 betId);

    /**
     * @notice Claim payout for an AUTO mode bet
     * @param betId The bet ID to claim
     */
    function claimAutoPayout(uint256 betId) external;

    /**
     * @notice Claim payout for a MANUAL mode bet using Merkle proof
     * @param betId The bet ID to claim
     * @param cashoutMultiplier The multiplier at which player cashed out
     * @param merkleProof The Merkle proof from the backend
     */
    function claimManualPayout(
        uint256 betId,
        uint32 cashoutMultiplier,
        bytes32[] calldata merkleProof
    ) external;

    /**
     * @notice Claim multiple bets in a single transaction (max 20)
     * @param claims Array of claim requests (AUTO and MANUAL mixed)
     */
    function batchClaim(ClaimRequest[] calldata claims) external;

    /**
     * @notice Settle round exposure in bulk (must be called before claims)
     * @param roundId The round ID
     * @param totalClaimable Sum of all payouts (AUTO + MANUAL) that winners can claim
     */
    function settleRoundExposure(uint256 roundId, uint256 totalClaimable) external;

    // ═══════════════════════════════════════════════════════════════════════════
    // OPERATOR FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Create a new round with a commitment
     * @param commitHash The hash of the server seed: keccak256(serverSeed)
     */
    function createRound(bytes32 commitHash) external;

    /**
     * @notice Start the round (close betting, enter Running state)
     */
    function startRound() external;

    /**
     * @notice Reveal the server seed after crash
     * @param roundId The round ID to reveal (must be crashed and not yet revealed)
     * @param serverSeed The pre-committed server seed
     */
    function revealSeed(uint256 roundId, bytes32 serverSeed) external;

    /**
     * @notice Submit Merkle root for MANUAL mode claims
     * @param roundId The round ID
     * @param merkleRoot The Merkle root of valid cashouts
     */
    function submitMerkleRoot(uint256 roundId, bytes32 merkleRoot) external;

    /**
     * @notice Emergency VRF refund: resolve round at par (1.00x) when VRF fails
     * @param roundId The round ID to refund
     */
    function emergencyVRFRefund(uint256 roundId) external;

    /**
     * @notice Expire unclaimed exposure after claim window passes
     * @param roundId The round ID to expire
     * @dev Anyone can call after claimWindowSeconds has elapsed since crashedAt.
     *      Releases remaining locked exposure for the round.
     */
    function expireUnclaimedExposure(uint256 roundId) external;

    // ═══════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    function getCurrentRound() external view returns (Round memory);
    function getRound(uint256 roundId) external view returns (Round memory);
    function getBet(uint256 betId) external view returns (Bet memory);
    function getPlayerBets(address player, uint256 roundId) external view returns (uint256[] memory);
    function getConfig() external view returns (GameConfig memory);
    function getTotalEdgeBps() external view returns (uint16);
    function isPlayerBanned(address player) external view returns (bool);

    /**
     * @notice Compute crash point from combined seed
     * @dev For provably-fair verification
     * @param vrfRandomWord The VRF random word
     * @param serverSeed The operator's server seed
     * @param roundId The round ID
     * @return crashPoint The crash multiplier in basis points
     */
    function computeCrashPoint(
        uint256 vrfRandomWord,
        bytes32 serverSeed,
        uint256 roundId
    ) external view returns (uint32 crashPoint);
}

