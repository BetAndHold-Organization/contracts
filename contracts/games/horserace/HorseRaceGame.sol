// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {PushVRFGame} from "../base/PushVRFGame.sol";
import {IHorseRaceGame} from "../../interfaces/games/horserace/IHorseRaceGame.sol";

/**
 * @title HorseRaceGame
 * @notice Provably-fair 4-lane horse race with EVA token integration.
 *
 * ## Lifecycle
 *
 *   createRace(roomId, tier, commitHash)        — operator, commits serverSeed hash
 *     → joinRace / joinRaceFor × k (k ≤ 4)      — players buy seats (lanes 0..k-1)
 *     → lockRace(roomId)                        — operator; fills lanes k..3 with house
 *                                                 horses, locks exposure, requests VRF
 *     → fulfillRandomness                       — RandomProvider stores the word
 *     → (race runs off-chain, deterministic)
 *     → settleRace(raceId, serverSeed, winnerLane, carrotDataHash)
 *
 *   The canonical operator flow bundles createRace + joinRaceFor×k + lockRace in ONE
 *   `multicallTry` so seats and money move atomically: a sub-call with a stale nonce
 *   reverts in isolation and the house simply covers that lane.
 *
 * ## Economics
 *
 *   Fees are NEVER hardcoded: the net pot derives from the PaymentHandler config at
 *   lock time (`getNetStakeBps`). With the platform target of 3% total fees:
 *     prize = 4 × tier × 0.97;   max bankroll exposure per race = 3 × tier × 0.97
 *   If a house lane wins, the collected net stakes remain in the bankroll, so the
 *   game's expected value is exactly the handler fees when house horses play a
 *   symmetric strategy (see the engine's house heuristic docs).
 *
 * ## Trust model
 *
 *   - Speed curves: deterministic from (vrfWord, serverSeed, raceId, lane); the engine
 *     parameters are anchored via engineConfigHash (snapshot per race).
 *   - Carrot presses: server-authoritative timestamps (same trust class as Crash
 *     MANUAL cashouts); their hash is anchored at settle for public recompute.
 *   - No operator bond: `emergencyRefundRace` is permissionless after the settle
 *     deadline, so a vanished operator can never trap player funds.
 */
contract HorseRaceGame is IHorseRaceGame, PushVRFGame {
    // ═══════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    uint8 public constant MIN_LANES = 2;
    uint8 public constant MAX_LANES = 8;
    uint8 public constant HOUSE_LANE_SENTINEL = 255;
    uint16 public constant MAX_BPS = 10_000;
    uint32 public constant EMERGENCY_GRACE_SECONDS = 30;
    uint32 public constant MIN_SETTLE_DEADLINE = 60;
    uint32 public constant MAX_SETTLE_DEADLINE = 1 days;

    /// @notice EIP-712 typehash for joinRaceFor. `address game` first — binds the
    ///         signature to this contract (defense-in-depth against replay).
    bytes32 public constant JOIN_RACE_TYPEHASH = keccak256(
        "JoinRace(address game,address player,bytes32 roomId,uint256 betAmount,address potentialReferrer,uint256 nonce,uint256 deadline)"
    );

    bytes32 private constant REASON_NOT_SETTLED = "NOT_SETTLED";
    bytes32 private constant REASON_CANCELLED = "CANCELLED";

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error InvalidCommitHash();
    error BetTierNotAllowed(uint256 amount);
    error RoomAlreadyUsed(bytes32 roomId);
    error RaceNotFound();
    error InvalidRaceState(RaceState expected, RaceState actual);
    error RaceFull();
    error AlreadyJoined(address player);
    error PlayerIsBanned(address player);
    error WrongBetAmount(uint256 expected, uint256 provided);
    error VRFNotFulfilled();
    error InvalidServerSeed();
    error InvalidWinnerLane(uint8 lane);
    error SettleDeadlineNotPassed(uint64 settleBy);
    error ConfigOutOfBounds();
    // InvalidSignature / ExpiredDeadline / InvalidNonce / NoSessionKey / NotOperator
    // come from the inherited SignedActionAuth mixin; LiquidityShortfall from BaseGame;
    // UnauthorizedCaller from VRFGameBase.

    // ═══════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════

    // Inherited: evaToken, paymentHandler, lockedExposure, randomProvider, authHub.

    uint256 public nextRaceId;  // first race gets id 1
    uint256 public nextBetId;   // first bet gets id 1

    mapping(uint256 => Race) private _races;
    mapping(uint256 => Seat[]) private _seats;
    mapping(bytes32 => uint256) public roomToRace;
    mapping(uint256 => uint256) public vrfRequestToRace;
    mapping(uint256 => mapping(address => bool)) public hasJoined;

    /// @notice Allowed bet tiers (room amounts), in token wei.
    mapping(uint256 => bool) public allowedBetAmounts;

    /// @notice Seconds after lock before anyone may force a refund.
    uint32 public settleDeadlineSeconds = 900;

    /// @notice Refund fraction over the GROSS bet (10_000 = players get their full
    ///         bet back; the house absorbs the already-distributed handler fees).
    uint16 public refundBps = 10_000;

    /// @notice Hash of the off-chain engine parameters; snapshotted per race at lock.
    bytes32 public currentEngineConfigHash;

    /// @notice Number of lanes (players) for NEW races, changeable by the owner
    ///         (`setLanes`). In-flight races keep the count they were created with
    ///         (snapshotted into `Race.laneCount` at createRace).
    uint8 public lanes = 4;

    /// @notice Game-level ban list (the PaymentHandler blacklist applies on top).
    mapping(address => bool) public bannedPlayers;

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(
        address token,
        address handler,
        address provider,
        address authHub_,
        address initialOperator,
        bytes32 engineConfigHash_
    ) PushVRFGame(token, handler, provider, authHub_, "HorseRaceGame", "1", initialOperator) {
        if (engineConfigHash_ == bytes32(0)) revert ConfigOutOfBounds();
        currentEngineConfigHash = engineConfigHash_;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // OPERATOR LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IHorseRaceGame
    function createRace(bytes32 roomId, uint256 betAmount, bytes32 commitHash)
        external
        onlyGameOperator
        whenNotPaused
        returns (uint256 raceId)
    {
        if (commitHash == bytes32(0)) revert InvalidCommitHash();
        if (!allowedBetAmounts[betAmount]) revert BetTierNotAllowed(betAmount);
        if (roomToRace[roomId] != 0) revert RoomAlreadyUsed(roomId);

        raceId = ++nextRaceId;
        Race storage race = _races[raceId];
        race.state = RaceState.Open;
        race.roomId = roomId;
        race.betAmount = betAmount;
        race.commitHash = commitHash;
        race.winnerLane = HOUSE_LANE_SENTINEL;
        // Snapshot the field size so an owner changing `lanes` mid-flight never
        // affects a race already created. Pre-size the seat array (players fill
        // lanes 0..k-1; the rest stay house lanes with player == address(0)).
        uint8 n = lanes;
        race.laneCount = n;
        for (uint8 i = 0; i < n; i++) {
            _seats[raceId].push();
        }
        roomToRace[roomId] = raceId;

        emit RaceCreated(raceId, roomId, betAmount, commitHash);
    }

    /// @inheritdoc IHorseRaceGame
    function lockRace(bytes32 roomId)
        external
        onlyGameOperator
        whenNotPaused
        nonReentrant
        returns (uint256 raceId)
    {
        raceId = roomToRace[roomId];
        if (raceId == 0) revert RaceNotFound();
        Race storage race = _races[raceId];
        if (race.state != RaceState.Open) {
            revert InvalidRaceState(RaceState.Open, race.state);
        }

        uint8 k = race.playerCount;
        if (k == 0) {
            race.state = RaceState.Cancelled;
            emit RaceCancelled(raceId);
            return raceId;
        }

        // Fees read from the PaymentHandler at lock time — never hardcoded.
        uint256 netPerSeat = (race.betAmount * paymentHandler.getNetStakeBps(address(this))) / MAX_BPS;
        uint256 houseTopUp = uint256(race.laneCount - k) * netPerSeat;

        // Exposure must cover the worst bankroll outflow beyond what this race
        // brought in: a player winning the full pot (houseTopUp) or a gross
        // refund of every seat (refund premium over the collected net).
        uint256 refundTotal = (uint256(k) * race.betAmount * refundBps) / MAX_BPS;
        uint256 refundPremium =
            refundTotal > race.totalNetCollected ? refundTotal - race.totalNetCollected : 0;
        uint256 exposure = houseTopUp > refundPremium ? houseTopUp : refundPremium;

        _lockExposure(exposure, 0);

        race.houseTopUp = houseTopUp;
        race.exposureLocked = exposure;
        race.lockedAt = uint64(block.timestamp);
        race.settleBy = uint64(block.timestamp) + settleDeadlineSeconds;
        race.engineConfigHash = currentEngineConfigHash;
        race.state = RaceState.Locked;

        uint256 requestId = randomProvider.requestRandomNumber(type(uint256).max);
        race.vrfRequestId = requestId;
        vrfRequestToRace[requestId] = raceId;

        emit RaceLocked(raceId, k, houseTopUp, requestId, race.settleBy, race.engineConfigHash);
    }

    /// @inheritdoc IHorseRaceGame
    function settleRace(
        uint256 raceId,
        bytes32 serverSeed,
        uint8 winnerLane,
        bytes32 carrotDataHash
    ) external onlyGameOperator nonReentrant {
        Race storage race = _races[raceId];
        if (race.state != RaceState.Locked) {
            revert InvalidRaceState(RaceState.Locked, race.state);
        }
        if (!race.vrfFulfilled) revert VRFNotFulfilled();
        if (keccak256(abi.encodePacked(serverSeed)) != race.commitHash) revert InvalidServerSeed();
        if (winnerLane >= race.laneCount) revert InvalidWinnerLane(winnerLane);

        _unlockExposure(race.exposureLocked, 0);

        race.state = RaceState.Settled;
        race.serverSeed = serverSeed;
        race.winnerLane = winnerLane;
        race.carrotDataHash = carrotDataHash;

        uint256 prize = race.totalNetCollected + race.houseTopUp;
        address winner = _seats[raceId][winnerLane].player;
        if (winner != address(0)) {
            _payPlayer(winner, prize);
        }
        // House lane winner: the net pot simply stays in the bankroll.

        for (uint8 lane = 0; lane < race.playerCount; lane++) {
            Seat storage seat = _seats[raceId][lane];
            emit BetSettled(
                seat.betId,
                seat.player,
                lane == winnerLane ? prize : 0,
                abi.encode(raceId, winnerLane, lane, serverSeed, carrotDataHash)
            );
        }

        emit RaceSettled(raceId, winnerLane, winner, prize, serverSeed, carrotDataHash);
    }

    /// @inheritdoc IHorseRaceGame
    function cancelRace(uint256 raceId) external onlyGameOperator nonReentrant {
        Race storage race = _races[raceId];
        if (race.state != RaceState.Open) {
            revert InvalidRaceState(RaceState.Open, race.state);
        }
        race.state = RaceState.Cancelled;
        _refundSeats(raceId, race, REASON_CANCELLED);
        emit RaceCancelled(raceId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PLAYER ENTRIES
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IHorseRaceGame
    function joinRace(bytes32 roomId, address potentialReferrer)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 betId)
    {
        return _joinInternal(msg.sender, roomId, potentialReferrer);
    }

    /// @inheritdoc IHorseRaceGame
    function joinRaceFor(
        address player,
        bytes32 roomId,
        uint256 betAmount,
        address potentialReferrer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOperator whenNotPaused nonReentrant returns (uint256 betId) {
        bytes32 structHash = keccak256(
            abi.encode(
                JOIN_RACE_TYPEHASH,
                address(this),
                player,
                roomId,
                betAmount,
                potentialReferrer,
                nonce,
                deadline
            )
        );
        _verifyAndConsume(player, address(this), betAmount, structHash, deadline, nonce, signature);

        uint256 raceId = roomToRace[roomId];
        if (raceId != 0 && betAmount != _races[raceId].betAmount) {
            revert WrongBetAmount(_races[raceId].betAmount, betAmount);
        }
        return _joinInternal(player, roomId, potentialReferrer);
    }

    function _joinInternal(address bettor, bytes32 roomId, address potentialReferrer)
        internal
        returns (uint256 betId)
    {
        uint256 raceId = roomToRace[roomId];
        if (raceId == 0) revert RaceNotFound();
        Race storage race = _races[raceId];
        if (race.state != RaceState.Open) {
            revert InvalidRaceState(RaceState.Open, race.state);
        }
        if (race.playerCount >= race.laneCount) revert RaceFull();
        if (bannedPlayers[bettor]) revert PlayerIsBanned(bettor);
        if (hasJoined[raceId][bettor]) revert AlreadyJoined(bettor);

        hasJoined[raceId][bettor] = true;
        uint256 netStake = _collectAndProcessBet(bettor, potentialReferrer, race.betAmount);

        uint8 lane = race.playerCount;
        race.playerCount = lane + 1;
        race.totalNetCollected += netStake;

        betId = ++nextBetId;
        _seats[raceId][lane] = Seat({player: bettor, betId: betId, netStake: netStake});

        emit PlayerJoined(raceId, bettor, lane, betId, race.betAmount, netStake);
        emit BetPlaced(betId, bettor, race.betAmount, abi.encode(raceId, roomId, lane, netStake));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VRF CALLBACKS (RandomProvider only)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Stores the VRF word for a Locked race. Late fulfillments after a
    ///         refund are ignored silently.
    function fulfillRandomness(uint256 requestId, uint256 randomWord, uint256[] memory)
        external
        override
        onlyRandomProvider
        nonReentrant
    {
        uint256 raceId = vrfRequestToRace[requestId];
        if (raceId == 0) return;
        Race storage race = _races[raceId];
        // Late fulfillment after a refund/emergency: ignore silently.
        if (race.state != RaceState.Locked) return;

        race.vrfRandomWord = randomWord;
        race.vrfFulfilled = true;
        emit RaceRandomnessFulfilled(raceId, randomWord);
    }

    /// @notice VRF failure → automatic refund of every seat and exposure unlock.
    function handleRandomFailure(uint256 requestId, bytes32 reason, bytes calldata)
        external
        override
        onlyRandomProvider
        nonReentrant
    {
        uint256 raceId = vrfRequestToRace[requestId];
        if (raceId == 0) return;
        Race storage race = _races[raceId];
        if (race.state != RaceState.Locked) return;

        _unlockExposure(race.exposureLocked, 0);
        race.state = RaceState.Refunded;
        _refundSeats(raceId, race, reason);
        emit RaceRefunded(raceId, reason);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PERMISSIONLESS SAFETY VALVE
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IHorseRaceGame
    function emergencyRefundRace(uint256 raceId) external nonReentrant {
        Race storage race = _races[raceId];
        if (race.state != RaceState.Locked) {
            revert InvalidRaceState(RaceState.Locked, race.state);
        }
        uint64 threshold = race.settleBy + EMERGENCY_GRACE_SECONDS;
        if (block.timestamp <= threshold) revert SettleDeadlineNotPassed(race.settleBy);

        _unlockExposure(race.exposureLocked, 0);
        race.state = RaceState.Refunded;
        _refundSeats(raceId, race, REASON_NOT_SETTLED);
        emit RaceRefunded(raceId, REASON_NOT_SETTLED);
    }

    /// @dev Push refunds are safe here: at most 4 seats and EVA has no transfer hooks.
    ///      `refundBps` applies over the GROSS bet — the house absorbs the handler
    ///      fees that were already distributed.
    function _refundSeats(uint256 raceId, Race storage race, bytes32 reason) private {
        uint256 refundPerSeat = (race.betAmount * refundBps) / MAX_BPS;
        for (uint8 lane = 0; lane < race.playerCount; lane++) {
            Seat storage seat = _seats[raceId][lane];
            if (refundPerSeat > 0) {
                _payPlayer(seat.player, refundPerSeat);
            }
            emit BetFailed(seat.betId, seat.player, reason);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    function setBetTier(uint256 amount, bool allowed) external onlyOwner {
        if (amount == 0) revert ConfigOutOfBounds();
        allowedBetAmounts[amount] = allowed;
        emit BetTierUpdated(amount, allowed);
    }

    function setSettleDeadlineSeconds(uint32 seconds_) external onlyOwner {
        if (seconds_ < MIN_SETTLE_DEADLINE || seconds_ > MAX_SETTLE_DEADLINE) {
            revert ConfigOutOfBounds();
        }
        settleDeadlineSeconds = seconds_;
        emit SettleDeadlineUpdated(seconds_);
    }

    function setRefundBps(uint16 bps) external onlyOwner {
        if (bps > MAX_BPS) revert ConfigOutOfBounds();
        refundBps = bps;
        emit RefundBpsUpdated(bps);
    }

    function setEngineConfigHash(bytes32 hash) external onlyOwner {
        if (hash == bytes32(0)) revert ConfigOutOfBounds();
        currentEngineConfigHash = hash;
        emit EngineConfigHashUpdated(hash);
    }

    function setPlayerBanned(address player, bool banned) external onlyOwner {
        bannedPlayers[player] = banned;
        emit PlayerBanStatusUpdated(player, banned);
    }

    /// @notice Set the number of lanes (players) for NEW races. Races already
    ///         created keep their own `laneCount` (snapshotted at createRace), so
    ///         changing this never affects an in-flight race.
    function setLanes(uint8 count) external onlyOwner {
        if (count < MIN_LANES || count > MAX_LANES) revert ConfigOutOfBounds();
        lanes = count;
        emit LanesUpdated(count);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEWS
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IHorseRaceGame
    function getRace(uint256 raceId) external view returns (Race memory) {
        return _races[raceId];
    }

    /// @inheritdoc IHorseRaceGame
    function getSeats(uint256 raceId) external view returns (Seat[] memory) {
        return _seats[raceId];
    }

    /// @inheritdoc IHorseRaceGame
    function getRaceIdByRoom(bytes32 roomId) external view returns (uint256) {
        return roomToRace[roomId];
    }
}
