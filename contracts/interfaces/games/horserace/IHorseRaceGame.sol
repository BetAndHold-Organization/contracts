// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

/**
 * @title IHorseRaceGame
 * @notice Interface for the Horse Race game contract.
 *
 *         4-lane multiplayer race. Each real player buys one seat (one horse)
 *         at the race's bet tier; empty lanes are filled by house horses at
 *         lock time. The winner takes the net pot:
 *
 *           prize = totalNetCollected + (4 - playerCount) * netPerSeat
 *                 = 4 * betAmount * netStakeBps / 10_000   (modulo rounding)
 *
 *         If a house lane wins, the collected net stakes stay in the bankroll.
 *
 *         Provably fair: the operator commits keccak256(serverSeed) at race
 *         creation (before any join and before VRF). Each lane's speed curve
 *         is derived off-chain from keccak256(vrfWord ‖ serverSeed ‖ raceId ‖
 *         lane) by the deterministic engine whose parameters are anchored via
 *         `engineConfigHash` (snapshotted per race). Carrot-press timestamps
 *         are server-authoritative (same trust model as Crash MANUAL
 *         cashouts); their hash is anchored on settle so anyone can recompute
 *         the full race and verify the winner.
 */
interface IHorseRaceGame {
    // ═══════════════════════════════════════════════════════════════════════
    // ENUMS
    // ═══════════════════════════════════════════════════════════════════════

    enum RaceState {
        None,       // 0: race doesn't exist
        Open,       // 1: created, seats can be joined
        Locked,     // 2: seats final, VRF requested, race runs off-chain
        Settled,    // 3: winner paid (or pot kept by house), seed revealed
        Refunded,   // 4: VRF failed or settle deadline missed — stakes refunded
        Cancelled   // 5: locked with zero players, or cancelled while Open
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════════

    struct Race {
        RaceState state;
        uint8 playerCount;          // real players seated (lanes 0..playerCount-1)
        uint8 winnerLane;           // 255 until settled
        uint64 lockedAt;
        uint64 settleBy;            // lockedAt + settleDeadlineSeconds
        bytes32 roomId;             // backend room identifier (signed by players)
        uint256 betAmount;          // gross per seat (the room tier)
        bytes32 commitHash;         // keccak256(abi.encodePacked(serverSeed))
        bytes32 serverSeed;         // zero until settled
        uint256 vrfRequestId;
        uint256 vrfRandomWord;
        bool vrfFulfilled;
        uint256 totalNetCollected;  // Σ actual net stakes from real seats
        uint256 houseTopUp;         // (4 - playerCount) * netPerSeat (formula)
        uint256 exposureLocked;     // amount locked on BaseGame.lockedExposure for this race
        bytes32 engineConfigHash;   // engine parameter snapshot for this race
        bytes32 carrotDataHash;     // anchored at settle for off-chain verification
    }

    struct Seat {
        address player;             // address(0) = house horse
        uint256 betId;              // global bet id (envelope requestId)
        uint256 netStake;           // actual net stake returned by the handler
    }

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS (detailed — the IGameEvents envelope is emitted alongside)
    // ═══════════════════════════════════════════════════════════════════════

    event RaceCreated(
        uint256 indexed raceId,
        bytes32 indexed roomId,
        uint256 betAmount,
        bytes32 commitHash
    );

    event PlayerJoined(
        uint256 indexed raceId,
        address indexed player,
        uint8 lane,
        uint256 betId,
        uint256 betAmount,
        uint256 netStake
    );

    event RaceLocked(
        uint256 indexed raceId,
        uint8 playerCount,
        uint256 houseTopUp,
        uint256 vrfRequestId,
        uint64 settleBy,
        bytes32 engineConfigHash
    );

    event RaceRandomnessFulfilled(uint256 indexed raceId, uint256 randomWord);

    event RaceSettled(
        uint256 indexed raceId,
        uint8 winnerLane,
        address winner,             // address(0) when a house lane wins
        uint256 prize,
        bytes32 serverSeed,
        bytes32 carrotDataHash
    );

    event RaceRefunded(uint256 indexed raceId, bytes32 reason);

    event RaceCancelled(uint256 indexed raceId);

    event BetTierUpdated(uint256 amount, bool allowed);

    event SettleDeadlineUpdated(uint32 seconds_);

    event RefundBpsUpdated(uint16 bps);

    event EngineConfigHashUpdated(bytes32 hash);

    event PlayerBanStatusUpdated(address indexed player, bool banned);

    // ═══════════════════════════════════════════════════════════════════════
    // OPERATOR LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Create a race for a backend room. Commits the server seed hash
    ///         BEFORE any join and before the VRF request.
    function createRace(bytes32 roomId, uint256 betAmount, bytes32 commitHash)
        external
        returns (uint256 raceId);

    /// @notice Close the seats. With zero players the race is Cancelled (no
    ///         revert, so an atomic multicall batch stays clean). Otherwise
    ///         locks the house top-up exposure and requests VRF.
    function lockRace(bytes32 roomId) external returns (uint256 raceId);

    /// @notice Reveal the server seed and settle. `winnerLane` is computed
    ///         off-chain by the deterministic engine; `carrotDataHash` anchors
    ///         the carrot events used, for public verification.
    function settleRace(
        uint256 raceId,
        bytes32 serverSeed,
        uint8 winnerLane,
        bytes32 carrotDataHash
    ) external;

    /// @notice Cancel a race that is still Open (e.g. lockRace failed inside
    ///         the batch). Refunds any joined seats.
    function cancelRace(uint256 raceId) external;

    // ═══════════════════════════════════════════════════════════════════════
    // PLAYER ENTRIES
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Direct entry: join an Open race paying its bet tier.
    function joinRace(bytes32 roomId, address potentialReferrer)
        external
        returns (uint256 betId);

    /// @notice Delegated entry relayed by an AuthHub operator with the
    ///         player's session-key EIP-712 signature.
    function joinRaceFor(
        address player,
        bytes32 roomId,
        uint256 betAmount,
        address potentialReferrer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 betId);

    // ═══════════════════════════════════════════════════════════════════════
    // PERMISSIONLESS SAFETY VALVE
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Anyone can force a refund if the operator hasn't settled by
    ///         `settleBy` (+ grace). Replaces an operator bond: the game's
    ///         max exposure per race is small and players can always exit.
    function emergencyRefundRace(uint256 raceId) external;

    // ═══════════════════════════════════════════════════════════════════════
    // VIEWS
    // ═══════════════════════════════════════════════════════════════════════

    function getRace(uint256 raceId) external view returns (Race memory);

    function getSeats(uint256 raceId) external view returns (Seat[4] memory);

    function getRaceIdByRoom(bytes32 roomId) external view returns (uint256);
}
