// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {PushVRFGame} from "../base/PushVRFGame.sol";
import {IHorseRaceBook} from "../../interfaces/games/horserace/IHorseRaceBook.sol";

/**
 * @title HorseRaceBook
 * @notice "Bet on a horse": the Horse Race run entirely by house horses, where
 *         players pick a lane and a free amount instead of riding a seat.
 *
 * ## Lifecycle
 *
 *   createRace(roomId, commitHash)                — operator, commits the seed hash
 *     → placeBet / placeBetFor × n (n ≤ maxBetsPerRace)
 *     → lockRace(roomId)                          — locks the worst-case exposure, requests VRF
 *     → fulfillRandomness                         — RandomProvider stores the word
 *     → (race runs off-chain, deterministic, every horse on autopilot)
 *     → settleRace(raceId, serverSeed, ranking, carrotDataHash)
 *
 * ## Economics
 *
 *   A bet on a lane that finishes at `place` pays
 *     netStake × laneCount × payoutSplitBps[place] / 10_000 × (10_000 − revelacionBps) / 10_000
 *   With 4 lanes and 60 / 30 / 10: 2.4× / 1.2× / 0.4× of the net stake (before
 *   the Revelación skim). The multipliers average 1× over the places, so with
 *   symmetric house horses the expected value is exactly the handler fees —
 *   the same edge as the seats mode. Nothing is hardcoded: fees come from the
 *   PaymentHandler at bet time, the split and the skim are owner config.
 *
 *   Exposure per race = worst-case pairing of lane totals with multipliers
 *   (largest total on the largest multiplier, …) minus what the race collected,
 *   or the refund premium if larger. Locked on `lockRace` against the bankroll.
 *
 *   Revelación: `revelacionBps` of the race's net stakes goes into a pool at
 *   settle (payouts are reduced by the same fraction, so the house edge is
 *   unchanged) and, 1 time in `revelacionOdds` — drawn from
 *   keccak(vrfRandomWord, serverSeed, raceId) — the pool is split pro-rata
 *   among the bets on the winning lane. The pool is held as locked exposure.
 *
 * ## Trust model — identical to HorseRaceGame: VRF word + committed server
 *   seed drive the speed curves, engine parameters are anchored by
 *   `engineConfigHash`, house carrot presses are hashed into `carrotDataHash`,
 *   and `emergencyRefundRace` is permissionless after the settle deadline.
 */
contract HorseRaceBook is IHorseRaceBook, PushVRFGame {
    // ═══════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════

    uint8 public constant MIN_LANES = 2;
    uint8 public constant MAX_LANES = 8;
    uint8 public constant HOUSE_LANE_SENTINEL = 255;
    uint16 public constant MAX_BPS = 10_000;
    uint16 public constant MAX_BETS_CAP = 100;
    uint32 public constant EMERGENCY_GRACE_SECONDS = 30;
    uint32 public constant MIN_SETTLE_DEADLINE = 60;
    uint32 public constant MAX_SETTLE_DEADLINE = 1 days;
    uint16 public constant MAX_REVELACION_BPS = 2_000;
    uint32 public constant MAX_REVELACION_ODDS = 10_000;

    /// @notice EIP-712 typehash for placeBetFor (`address game` first).
    bytes32 public constant LANE_BET_TYPEHASH = keccak256(
        "LaneBet(address game,address player,bytes32 roomId,uint8 lane,uint256 amount,address potentialReferrer,uint256 nonce,uint256 deadline)"
    );

    bytes32 private constant REASON_NOT_SETTLED = "NOT_SETTLED";
    bytes32 private constant REASON_CANCELLED = "CANCELLED";

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error InvalidCommitHash();
    error RoomAlreadyUsed(bytes32 roomId);
    error RaceNotFound();
    error InvalidRaceState(RaceState expected, RaceState actual);
    error RaceFull();
    error AlreadyBet(address player);
    error PlayerIsBanned(address player);
    error InvalidLane(uint8 lane);
    error BetOutOfRange(uint256 amount, uint256 minBet, uint256 maxBet);
    error VRFNotFulfilled();
    error InvalidServerSeed();
    error InvalidRanking();
    error SettleDeadlineNotPassed(uint64 settleBy);
    error ConfigOutOfBounds();

    // ═══════════════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════════════

    uint256 public nextRaceId;
    uint256 public nextBetId;

    mapping(uint256 => Race) private _races;
    mapping(uint256 => Bet[]) private _bets;
    /// @dev net stake per lane: _laneNet[raceId][lane]
    mapping(uint256 => mapping(uint8 => uint256)) private _laneNet;
    mapping(bytes32 => uint256) public roomToRace;
    mapping(uint256 => uint256) public vrfRequestToRace;
    mapping(uint256 => mapping(address => bool)) public hasBet;

    uint256 public minBet = 0.1 ether;
    uint256 public maxBet = 2 ether;
    uint16 public maxBetsPerRace = 48;

    uint32 public settleDeadlineSeconds = 900;
    uint16 public refundBps = 10_000;
    bytes32 public currentEngineConfigHash;
    uint8 public lanes = 4;
    mapping(address => bool) public bannedPlayers;

    uint16[] private _payoutSplitBps;

    uint16 public revelacionBps = 300;
    uint32 public revelacionOdds = 20;
    uint256 public revelacionPool;

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
    ) PushVRFGame(token, handler, provider, authHub_, "HorseRaceBook", "1", initialOperator) {
        if (engineConfigHash_ == bytes32(0)) revert ConfigOutOfBounds();
        _payoutSplitBps.push(6_000);
        _payoutSplitBps.push(3_000);
        _payoutSplitBps.push(1_000);
        currentEngineConfigHash = engineConfigHash_;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // OPERATOR LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IHorseRaceBook
    function createRace(bytes32 roomId, bytes32 commitHash)
        external
        onlyGameOperator
        whenNotPaused
        returns (uint256 raceId)
    {
        if (commitHash == bytes32(0)) revert InvalidCommitHash();
        if (roomToRace[roomId] != 0) revert RoomAlreadyUsed(roomId);

        raceId = ++nextRaceId;
        Race storage race = _races[raceId];
        race.state = RaceState.Open;
        race.roomId = roomId;
        race.commitHash = commitHash;
        race.winnerLane = HOUSE_LANE_SENTINEL;
        race.laneCount = lanes;
        roomToRace[roomId] = raceId;

        emit RaceCreated(raceId, roomId, commitHash);
    }

    /// @inheritdoc IHorseRaceBook
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

        if (race.betCount == 0) {
            race.state = RaceState.Cancelled;
            emit RaceCancelled(raceId);
            return raceId;
        }

        // Worst bankroll outflow beyond what the race collected: the most
        // expensive finishing order, or a gross refund of every bet.
        uint256 worstPayout = _worstCasePayout(raceId, race.laneCount);
        uint256 net = race.totalNetCollected;
        uint256 payoutPremium = worstPayout > net ? worstPayout - net : 0;
        uint256 refundTotal = (race.totalGrossCollected * refundBps) / MAX_BPS;
        uint256 refundPremium = refundTotal > net ? refundTotal - net : 0;
        uint256 exposure = payoutPremium > refundPremium ? payoutPremium : refundPremium;

        _lockExposure(exposure, 0);

        race.exposureLocked = exposure;
        race.lockedAt = uint64(block.timestamp);
        race.settleBy = uint64(block.timestamp) + settleDeadlineSeconds;
        race.engineConfigHash = currentEngineConfigHash;
        race.state = RaceState.Locked;

        uint256 requestId = randomProvider.requestRandomNumber(type(uint256).max);
        race.vrfRequestId = requestId;
        vrfRequestToRace[requestId] = raceId;

        emit RaceLocked(raceId, race.betCount, net, exposure, requestId, race.settleBy, race.engineConfigHash);
    }

    /// @dev Largest lane total on the largest multiplier, and so on (rearrangement
    ///      inequality): the maximum the house can pay for any finishing order,
    ///      before the Revelación skim (an upper bound, kept simple).
    function _worstCasePayout(uint256 raceId, uint8 laneCount) private view returns (uint256 worst) {
        uint256[] memory totals = new uint256[](laneCount);
        for (uint8 lane = 0; lane < laneCount; lane++) totals[lane] = _laneNet[raceId][lane];
        _sortDesc(totals);
        uint256[] memory mults = new uint256[](_payoutSplitBps.length);
        for (uint256 i = 0; i < mults.length; i++) mults[i] = _payoutSplitBps[i];
        _sortDesc(mults);
        uint256 places = mults.length < laneCount ? mults.length : laneCount;
        for (uint256 i = 0; i < places; i++) {
            worst += (totals[i] * laneCount * mults[i]) / MAX_BPS;
        }
    }

    /// @dev Selection sort, descending — arrays here hold at most MAX_LANES items.
    function _sortDesc(uint256[] memory a) private pure {
        for (uint256 i = 0; i < a.length; i++) {
            uint256 best = i;
            for (uint256 j = i + 1; j < a.length; j++) {
                if (a[j] > a[best]) best = j;
            }
            if (best != i) (a[i], a[best]) = (a[best], a[i]);
        }
    }

    /// @inheritdoc IHorseRaceBook
    function settleRace(
        uint256 raceId,
        bytes32 serverSeed,
        uint8[] calldata ranking,
        bytes32 carrotDataHash
    ) external onlyGameOperator nonReentrant {
        Race storage race = _races[raceId];
        if (race.state != RaceState.Locked) {
            revert InvalidRaceState(RaceState.Locked, race.state);
        }
        if (!race.vrfFulfilled) revert VRFNotFulfilled();
        if (keccak256(abi.encodePacked(serverSeed)) != race.commitHash) revert InvalidServerSeed();
        uint8 laneCount = race.laneCount;
        _checkRanking(ranking, laneCount);
        uint8 winnerLane = ranking[0];

        _unlockExposure(race.exposureLocked, 0);

        race.state = RaceState.Settled;
        race.serverSeed = serverSeed;
        race.winnerLane = winnerLane;
        race.carrotDataHash = carrotDataHash;

        // Revelación skim: a slice of the net stakes goes into the pool, held
        // as locked exposure so no later lock can spend it.
        {
            uint256 contrib = (race.totalNetCollected * revelacionBps) / MAX_BPS;
            if (contrib > 0) {
                revelacionPool += contrib;
                _lockExposure(contrib, 0);
                emit RevelacionContributed(raceId, contrib, revelacionPool);
            }
        }

        // place of each lane (255 = beyond the paid places)
        uint8[] memory placeOf = new uint8[](laneCount);
        for (uint8 lane = 0; lane < laneCount; lane++) placeOf[lane] = HOUSE_LANE_SENTINEL;
        uint256 paidPlaces = _payoutSplitBps.length < laneCount ? _payoutSplitBps.length : laneCount;
        for (uint8 place = 0; place < paidPlaces; place++) placeOf[ranking[place]] = place;

        Bet[] storage bets = _bets[raceId];
        uint256[] memory payouts = new uint256[](bets.length);
        for (uint256 i = 0; i < bets.length; i++) {
            uint8 place = placeOf[bets[i].lane];
            if (place != HOUSE_LANE_SENTINEL) payouts[i] = _payoutFor(laneCount, bets[i].netStake, place);
        }

        // Revelación draw: the pool goes, pro-rata, to the bets on the winning lane.
        uint256 winnerNet = _laneNet[raceId][winnerLane];
        if (
            revelacionOdds > 0 && revelacionPool > 0 && winnerNet > 0 &&
            uint256(keccak256(abi.encodePacked(race.vrfRandomWord, serverSeed, raceId))) % revelacionOdds == 0
        ) {
            uint256 bonus = revelacionPool;
            revelacionPool = 0;
            _unlockExposure(bonus, 0);
            uint256 handed;
            uint256 lastWinner = type(uint256).max;
            for (uint256 i = 0; i < bets.length; i++) {
                if (bets[i].lane == winnerLane) lastWinner = i;
            }
            for (uint256 i = 0; i < bets.length; i++) {
                if (bets[i].lane != winnerLane) continue;
                // the last winning bet takes the rounding dust so the pool empties exactly
                uint256 share = i == lastWinner ? bonus - handed : (bonus * bets[i].netStake) / winnerNet;
                handed += share;
                payouts[i] += share;
                emit RevelacionShare(raceId, bets[i].player, bets[i].betId, share);
            }
            emit RevelacionWon(raceId, winnerLane, bonus);
        }

        uint256 totalPaid;
        for (uint256 i = 0; i < bets.length; i++) {
            Bet storage bet = bets[i];
            if (payouts[i] > 0) {
                totalPaid += payouts[i];
                _payPlayer(bet.player, payouts[i]);
            }
            emit BetSettled(
                bet.betId,
                bet.player,
                payouts[i],
                abi.encode(raceId, winnerLane, bet.lane, serverSeed, carrotDataHash)
            );
        }

        emit RacePodium(raceId, ranking, _laneTotals(raceId, laneCount));
        emit RaceSettled(raceId, winnerLane, race.totalNetCollected, totalPaid, serverSeed, carrotDataHash);
    }

    /// @dev netStake × laneCount × split[place] × (1 − revelacionBps), all in bps
    ///      (one division at the end: no precision lost, no overflow — the
    ///      product stays far below 2^256 for any stake the limits allow).
    function _payoutFor(uint8 laneCount, uint256 netStake, uint8 place) private view returns (uint256) {
        return (netStake * laneCount * _payoutSplitBps[place] * (MAX_BPS - revelacionBps)) / (uint256(MAX_BPS) * MAX_BPS);
    }

    /// @dev `ranking` must be a permutation of every lane (0..laneCount-1).
    function _checkRanking(uint8[] calldata ranking, uint8 laneCount) private pure {
        if (ranking.length != laneCount) revert InvalidRanking();
        uint256 seen;
        for (uint256 i = 0; i < ranking.length; i++) {
            uint8 lane = ranking[i];
            if (lane >= laneCount) revert InvalidLane(lane);
            uint256 bit = uint256(1) << lane;
            if (seen & bit != 0) revert InvalidRanking();
            seen |= bit;
        }
    }

    /// @inheritdoc IHorseRaceBook
    function cancelRace(uint256 raceId) external onlyGameOperator nonReentrant {
        Race storage race = _races[raceId];
        if (race.state != RaceState.Open) {
            revert InvalidRaceState(RaceState.Open, race.state);
        }
        race.state = RaceState.Cancelled;
        _refundBets(raceId, REASON_CANCELLED);
        emit RaceCancelled(raceId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PLAYER ENTRIES
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IHorseRaceBook
    function placeBet(bytes32 roomId, uint8 lane, uint256 amount, address potentialReferrer)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 betId)
    {
        return _placeBetInternal(msg.sender, roomId, lane, amount, potentialReferrer);
    }

    /// @inheritdoc IHorseRaceBook
    function placeBetFor(
        address player,
        bytes32 roomId,
        uint8 lane,
        uint256 amount,
        address potentialReferrer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOperator whenNotPaused nonReentrant returns (uint256 betId) {
        bytes32 structHash = keccak256(
            abi.encode(LANE_BET_TYPEHASH, address(this), player, roomId, lane, amount, potentialReferrer, nonce, deadline)
        );
        _verifyAndConsume(player, address(this), amount, structHash, deadline, nonce, signature);
        return _placeBetInternal(player, roomId, lane, amount, potentialReferrer);
    }

    function _placeBetInternal(address bettor, bytes32 roomId, uint8 lane, uint256 amount, address potentialReferrer)
        internal
        returns (uint256 betId)
    {
        uint256 raceId = roomToRace[roomId];
        if (raceId == 0) revert RaceNotFound();
        Race storage race = _races[raceId];
        if (race.state != RaceState.Open) {
            revert InvalidRaceState(RaceState.Open, race.state);
        }
        if (lane >= race.laneCount) revert InvalidLane(lane);
        if (amount < minBet || amount > maxBet) revert BetOutOfRange(amount, minBet, maxBet);
        if (race.betCount >= maxBetsPerRace) revert RaceFull();
        if (bannedPlayers[bettor]) revert PlayerIsBanned(bettor);
        if (hasBet[raceId][bettor]) revert AlreadyBet(bettor);

        hasBet[raceId][bettor] = true;
        uint256 netStake = _collectAndProcessBet(bettor, potentialReferrer, amount);

        race.betCount += 1;
        race.totalNetCollected += netStake;
        race.totalGrossCollected += amount;
        _laneNet[raceId][lane] += netStake;

        betId = ++nextBetId;
        _bets[raceId].push(Bet({player: bettor, lane: lane, betId: betId, grossStake: amount, netStake: netStake}));

        emit LaneBetPlaced(raceId, bettor, lane, betId, amount, netStake);
        emit BetPlaced(betId, bettor, amount, abi.encode(raceId, roomId, lane, netStake));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VRF CALLBACKS (RandomProvider only)
    // ═══════════════════════════════════════════════════════════════════════

    function fulfillRandomness(uint256 requestId, uint256 randomWord, uint256[] memory)
        external
        override
        onlyRandomProvider
        nonReentrant
    {
        uint256 raceId = vrfRequestToRace[requestId];
        if (raceId == 0) return;
        Race storage race = _races[raceId];
        if (race.state != RaceState.Locked) return;

        race.vrfRandomWord = randomWord;
        race.vrfFulfilled = true;
        emit RaceRandomnessFulfilled(raceId, randomWord);
    }

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
        _refundBets(raceId, reason);
        emit RaceRefunded(raceId, reason);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PERMISSIONLESS SAFETY VALVE
    // ═══════════════════════════════════════════════════════════════════════

    /// @inheritdoc IHorseRaceBook
    function emergencyRefundRace(uint256 raceId) external nonReentrant {
        Race storage race = _races[raceId];
        if (race.state != RaceState.Locked) {
            revert InvalidRaceState(RaceState.Locked, race.state);
        }
        uint64 threshold = race.settleBy + EMERGENCY_GRACE_SECONDS;
        if (block.timestamp <= threshold) revert SettleDeadlineNotPassed(race.settleBy);

        _unlockExposure(race.exposureLocked, 0);
        race.state = RaceState.Refunded;
        _refundBets(raceId, REASON_NOT_SETTLED);
        emit RaceRefunded(raceId, REASON_NOT_SETTLED);
    }

    /// @dev Push refunds over the GROSS stake × refundBps; bounded by maxBetsPerRace
    ///      and EVA has no transfer hooks.
    function _refundBets(uint256 raceId, bytes32 reason) private {
        Bet[] storage bets = _bets[raceId];
        for (uint256 i = 0; i < bets.length; i++) {
            uint256 refund = (bets[i].grossStake * refundBps) / MAX_BPS;
            if (refund > 0) _payPlayer(bets[i].player, refund);
            emit BetFailed(bets[i].betId, bets[i].player, reason);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    function setBetLimits(uint256 minBet_, uint256 maxBet_, uint16 maxBetsPerRace_) external onlyOwner {
        if (minBet_ == 0 || maxBet_ < minBet_ || maxBetsPerRace_ == 0 || maxBetsPerRace_ > MAX_BETS_CAP) {
            revert ConfigOutOfBounds();
        }
        minBet = minBet_;
        maxBet = maxBet_;
        maxBetsPerRace = maxBetsPerRace_;
        emit BetLimitsUpdated(minBet_, maxBet_, maxBetsPerRace_);
    }

    function setSettleDeadlineSeconds(uint32 seconds_) external onlyOwner {
        if (seconds_ < MIN_SETTLE_DEADLINE || seconds_ > MAX_SETTLE_DEADLINE) revert ConfigOutOfBounds();
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

    /// @notice Share of the "pot" per finishing place (index 0 = winner), in bps;
    ///         a bet's multiplier is laneCount × share. Must sum to at most MAX_BPS.
    function setPayoutSplitBps(uint16[] calldata bps) external onlyOwner {
        if (bps.length == 0 || bps.length > MAX_LANES) revert ConfigOutOfBounds();
        uint256 total;
        for (uint256 i = 0; i < bps.length; i++) total += bps[i];
        if (total == 0 || total > MAX_BPS) revert ConfigOutOfBounds();
        delete _payoutSplitBps;
        for (uint256 i = 0; i < bps.length; i++) _payoutSplitBps.push(bps[i]);
        emit PayoutSplitUpdated(bps);
    }

    function setRevelacion(uint16 bps, uint32 odds) external onlyOwner {
        if (bps > MAX_REVELACION_BPS || odds > MAX_REVELACION_ODDS) revert ConfigOutOfBounds();
        revelacionBps = bps;
        revelacionOdds = odds;
        emit RevelacionUpdated(bps, odds);
    }

    function setLanes(uint8 count) external onlyOwner {
        if (count < MIN_LANES || count > MAX_LANES) revert ConfigOutOfBounds();
        lanes = count;
        emit LanesUpdated(count);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEWS
    // ═══════════════════════════════════════════════════════════════════════

    function getRace(uint256 raceId) external view returns (Race memory) {
        return _races[raceId];
    }

    function getBets(uint256 raceId) external view returns (Bet[] memory) {
        return _bets[raceId];
    }

    function getLaneTotals(uint256 raceId) external view returns (uint256[] memory) {
        return _laneTotals(raceId, _races[raceId].laneCount);
    }

    function _laneTotals(uint256 raceId, uint8 laneCount) private view returns (uint256[] memory totals) {
        totals = new uint256[](laneCount);
        for (uint8 lane = 0; lane < laneCount; lane++) totals[lane] = _laneNet[raceId][lane];
    }

    function getRaceIdByRoom(bytes32 roomId) external view returns (uint256) {
        return roomToRace[roomId];
    }

    function getPayoutSplitBps() external view returns (uint16[] memory) {
        return _payoutSplitBps;
    }

    function getRevelacion() external view returns (uint256 pool, uint16 bps, uint32 odds) {
        return (revelacionPool, revelacionBps, revelacionOdds);
    }

    function getBetLimits() external view returns (uint256, uint256, uint16) {
        return (minBet, maxBet, maxBetsPerRace);
    }

    function quotePayout(uint8 laneCount, uint256 netStake, uint8 place) external view returns (uint256) {
        if (place >= _payoutSplitBps.length) return 0;
        return _payoutFor(laneCount, netStake, place);
    }
}
