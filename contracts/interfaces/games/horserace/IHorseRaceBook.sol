// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

/**
 * @title IHorseRaceBook
 * @notice Interface for the "bet on a horse" mode of the Horse Race.
 *
 *         Every horse is a house horse (nobody rides) and the horses are NOT
 *         equal: the engine config anchored by `engineConfigHash` gives each
 *         lane its own speed, hence its own win probability. Players pick a
 *         lane and a free amount within the bet limits, as many bets as they
 *         like (one race holds at most maxBetsPerRace). The deterministic
 *         engine runs the race off-chain from the VRF word and the committed
 *         server seed; the operator settles with the full finishing order.
 *
 *         Fixed odds, win only: a bet pays `netStake × laneOddsBps[lane] / 1e4`
 *         when its horse wins and nothing otherwise, where laneOddsBps[i] =
 *         1e4 / p_i (fair odds on the net stake, p_i measured by simulation
 *         on the anchored engine config). The expected payout of every bet is
 *         its net stake, so the house edge is exactly the platform fees on
 *         every bet, whatever the players do. The race's exposure is its most
 *         expensive winner; a bet the bankroll could not pay is refused.
 *
 *         Revelación: `revelacionBps` of every bet's net stake feeds a pool
 *         (payouts are reduced by the same fraction) and, 1 time in
 *         `revelacionOdds` per settled race, the pool is split pro-rata among
 *         the bets on the winning lane.
 */
interface IHorseRaceBook {
    enum RaceState {
        None,       // 0
        Open,       // 1: bets accepted
        Locked,     // 2: bets final, VRF requested
        Settled,    // 3: paid out, seed revealed
        Refunded,   // 4: VRF failed or settle deadline missed — stakes refunded
        Cancelled   // 5: locked with zero bets, or cancelled while Open
    }

    struct Race {
        RaceState state;
        uint8 laneCount;            // field size snapshotted at createRace
        uint8 winnerLane;           // 255 until settled
        uint16 betCount;            // bets placed
        uint64 lockedAt;
        uint64 settleBy;
        bytes32 roomId;
        bytes32 commitHash;         // keccak256(abi.encodePacked(serverSeed))
        bytes32 serverSeed;         // zero until settled
        uint256 vrfRequestId;
        uint256 vrfRandomWord;
        bool vrfFulfilled;
        uint256 totalNetCollected;  // Σ net stakes
        uint256 totalGrossCollected;// Σ gross stakes (refund basis)
        uint256 exposureLocked;
        bytes32 engineConfigHash;
        bytes32 carrotDataHash;     // anchored at settle (house carrots)
    }

    struct Bet {
        address player;
        uint8 lane;
        uint256 betId;
        uint256 grossStake;
        uint256 netStake;
    }

    event RaceCreated(uint256 indexed raceId, bytes32 indexed roomId, bytes32 commitHash);
    event LaneBetPlaced(
        uint256 indexed raceId,
        address indexed player,
        uint8 lane,
        uint256 betId,
        uint256 amount,
        uint256 netStake
    );
    event RaceLocked(
        uint256 indexed raceId,
        uint16 betCount,
        uint256 totalNet,
        uint256 exposure,
        uint256 vrfRequestId,
        uint64 settleBy,
        bytes32 engineConfigHash
    );
    event RaceRandomnessFulfilled(uint256 indexed raceId, uint256 randomWord);
    /// @notice Final classification and the net stake that rode on each lane.
    event RacePodium(uint256 indexed raceId, uint8[] ranking, uint256[] laneTotals);
    event RaceSettled(
        uint256 indexed raceId,
        uint8 winnerLane,
        uint256 totalNet,
        uint256 totalPaid,
        bytes32 serverSeed,
        bytes32 carrotDataHash
    );
    event RaceRefunded(uint256 indexed raceId, bytes32 reason);
    event RaceCancelled(uint256 indexed raceId);

    event RevelacionContributed(uint256 indexed raceId, uint256 amount, uint256 pool);
    /// @notice The pool was paid out, pro-rata, to the bets on the winning lane.
    event RevelacionWon(uint256 indexed raceId, uint8 winnerLane, uint256 amount);
    event RevelacionShare(uint256 indexed raceId, address indexed player, uint256 betId, uint256 amount);
    event RevelacionUpdated(uint16 bps, uint32 odds);

    event BetLimitsUpdated(uint256 minBet, uint256 maxBet, uint16 maxBetsPerRace);
    /// @notice New odds table (bps over the net stake, index = lane) for races created from now on.
    event LaneOddsUpdated(uint32[] bps);
    event SettleDeadlineUpdated(uint32 seconds_);
    event RefundBpsUpdated(uint16 bps);
    event EngineConfigHashUpdated(bytes32 hash);
    event PlayerBanStatusUpdated(address indexed player, bool banned);
    event LanesUpdated(uint8 lanes);

    // operator lifecycle
    function createRace(bytes32 roomId, bytes32 commitHash) external returns (uint256 raceId);
    function lockRace(bytes32 roomId) external returns (uint256 raceId);
    function settleRace(uint256 raceId, bytes32 serverSeed, uint8[] calldata ranking, bytes32 carrotDataHash) external;
    function cancelRace(uint256 raceId) external;

    // player entries
    function placeBet(bytes32 roomId, uint8 lane, uint256 amount, address potentialReferrer)
        external
        returns (uint256 betId);
    function placeBetFor(
        address player,
        bytes32 roomId,
        uint8 lane,
        uint256 amount,
        address potentialReferrer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256 betId);

    // permissionless safety valve
    function emergencyRefundRace(uint256 raceId) external;

    // views
    function getRace(uint256 raceId) external view returns (Race memory);
    function getBets(uint256 raceId) external view returns (Bet[] memory);
    /// @notice Net stake riding on each lane of a race (index = lane).
    function getLaneTotals(uint256 raceId) external view returns (uint256[] memory);
    function getRaceIdByRoom(bytes32 roomId) external view returns (uint256);
    /// @notice Odds per lane for NEW races (bps over the net stake, index = lane).
    function getLaneOdds() external view returns (uint32[] memory);
    /// @notice The odds a race was opened with (what its bets are paid at).
    function getRaceOdds(uint256 raceId) external view returns (uint32[] memory);
    function getRevelacion() external view returns (uint256 pool, uint16 bps, uint32 odds);
    function getBetLimits() external view returns (uint256 minBet, uint256 maxBet, uint16 maxBetsPerRace);
    /// @notice What a bet of `netStake` on `lane` is paid if that horse wins,
    ///         after the Revelación skim, at the current odds (0 for an unknown lane).
    function quotePayout(uint8 lane, uint256 netStake) external view returns (uint256);
}
