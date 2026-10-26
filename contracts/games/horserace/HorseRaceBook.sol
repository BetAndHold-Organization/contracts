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
 *   createRace(roomId, commitHash)                — operator, commits the seed hash, snapshots the odds
 *     → placeBet / placeBetFor × n (n ≤ maxBetsPerRace; a player may bet several times / lanes)
 *     → lockRace(roomId)                          — locks the worst-case exposure, requests VRF
 *     → fulfillRandomness                         — RandomProvider stores the word
 *     → (race runs off-chain, deterministic, every horse on autopilot)
 *     → settleRace(raceId, serverSeed, ranking, carrotDataHash)
 *
 * ## Economics — fixed odds, win only
 *
 *   The horses are NOT equal: the engine config anchored by `engineConfigHash`
 *   gives each lane its own speed factor, so each lane has its own win
 *   probability p_i (measured by Monte Carlo on that exact config). A bet pays
 *   only if its horse WINS:
 *     payout = netStake × laneOddsBps[lane] / 10_000 × (10_000 − revelacionBps) / 10_000
 *   with laneOddsBps[i] = 10_000 / p_i (fair odds on the NET stake). The
 *   expected payout of any bet is then exactly its net stake, so the house
 *   edge is exactly the PaymentHandler fees (3 %), whatever lanes the bets
 *   land on and however many bets a player places. The odds are owner config
 *   (`setLaneOdds`), snapshotted per race at createRace, and must be re-derived
 *   whenever the engine config changes.
 *
 *   Exposure per race = the most expensive winner: max_i(laneNet_i × odds_i)
 *   minus what the race collected (or the refund premium if larger). It is
 *   checked at every placeBet against the available liquidity — a bet the
 *   bankroll could not pay is refused up front — and locked at lockRace.
 *
 *   Revelación: `revelacionBps` of the race's net stakes goes into a pool at
 *   settle (payouts are reduced by the same fraction, so the house edge is
 *   unchanged over time) and, 1 time in `revelacionOdds` — drawn from
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
    /// @notice Odds bounds (bps over the net stake): ×1.0 … ×200.
    uint32 public constant MIN_ODDS_BPS = 10_000;
    uint32 public constant MAX_ODDS_BPS = 2_000_000;
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
    /// @notice The bankroll could not pay this bet if its horse won (available liquidity vs the worst case).
    error BetExceedsLiquidity(uint256 available, uint256 required);
    error OddsNotConfigured();
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
    /// @dev odds snapshot per race (bps over the net stake, index = lane)
    mapping(uint256 => uint32[]) private _raceOdds;

    uint256 public minBet = 0.1 ether;
    uint256 public maxBet = 2 ether;
    uint16 public maxBetsPerRace = 48;

    uint32 public settleDeadlineSeconds = 900;
    uint16 public refundBps = 10_000;
    bytes32 public currentEngineConfigHash;
    uint8 public lanes = 4;
    mapping(address => bool) public bannedPlayers;

    /// @notice Current odds per lane (bps over the net stake): 10_000 / winProbability.
    uint32[] private _laneOddsBps;

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
        if (_laneOddsBps.length != lanes) revert OddsNotConfigured();

        raceId = ++nextRaceId;
        _raceOdds[raceId] = _laneOddsBps;
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
        // expensive winner, or a gross refund of every bet.
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

    /// @dev The most expensive winner: max over lanes of laneNet × odds (before
    ///      the Revelación skim — an upper bound, kept simple).
    function _worstCasePayout(uint256 raceId, uint8 laneCount) private view returns (uint256 worst) {
        uint32[] storage odds = _raceOdds[raceId];
        for (uint8 lane = 0; lane < laneCount; lane++) {
            uint256 liability = (_laneNet[raceId][lane] * odds[lane]) / MAX_BPS;
            if (liability > worst) worst = liability;
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

        // Win only: the bets on the winning lane are paid at that lane's odds.
        Bet[] storage bets = _bets[raceId];
        uint256[] memory payouts = new uint256[](bets.length);
        uint32 winnerOdds = _raceOdds[raceId][winnerLane];
        for (uint256 i = 0; i < bets.length; i++) {
            if (bets[i].lane == winnerLane) payouts[i] = _payoutFor(bets[i].netStake, winnerOdds);
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

    /// @dev netStake × odds × (1 − revelacionBps), all in bps — one division at
    ///      the end: no precision lost, no overflow for any stake the limits allow.
    function _payoutFor(uint256 netStake, uint32 oddsBps) private view returns (uint256) {
        return (netStake * oddsBps * (MAX_BPS - revelacionBps)) / (uint256(MAX_BPS) * MAX_BPS);
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

        uint256 netStake = _collectAndProcessBet(bettor, potentialReferrer, amount);

        race.betCount += 1;
        race.totalNetCollected += netStake;
        race.totalGrossCollected += amount;
        _laneNet[raceId][lane] += netStake;

        // Refuse a bet the bankroll could not pay: the worst case of THIS race
        // (its most expensive winner, beyond what it collected) must fit in
        // what is not already locked for other races / the Revelación pool.
        // (The stake just collected is in the balance; lockRace locks the same figure.)
        {
            uint256 worst = _worstCasePayout(raceId, race.laneCount);
            uint256 needed = worst > race.totalNetCollected ? worst - race.totalNetCollected : 0;
            uint256 balance = evaToken.balanceOf(address(this));
            uint256 available = balance > lockedExposure ? balance - lockedExposure : 0;
            if (needed > available) revert BetExceedsLiquidity(available, needed);
        }

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

    /// @notice Odds per lane (bps over the net stake, index = lane): 10_000 / p_i
    ///         for the win probability p_i of that lane under the anchored engine
    ///         config. One entry per lane of `lanes`; applies to races created
    ///         from now on (each race snapshots the odds it was opened with).
    function setLaneOdds(uint32[] calldata bps) external onlyOwner {
        if (bps.length != lanes) revert ConfigOutOfBounds();
        for (uint256 i = 0; i < bps.length; i++) {
            if (bps[i] < MIN_ODDS_BPS || bps[i] > MAX_ODDS_BPS) revert ConfigOutOfBounds();
        }
        delete _laneOddsBps;
        for (uint256 i = 0; i < bps.length; i++) _laneOddsBps.push(bps[i]);
        emit LaneOddsUpdated(bps);
    }

    function setRevelacion(uint16 bps, uint32 odds) external onlyOwner {
        if (bps > MAX_REVELACION_BPS || odds > MAX_REVELACION_ODDS) revert ConfigOutOfBounds();
        revelacionBps = bps;
        revelacionOdds = odds;
        emit RevelacionUpdated(bps, odds);
    }

    /// @notice Field size for NEW races. The odds table must be set again for
    ///         the new size before a race can be created (createRace checks it).
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

    function getLaneOdds() external view returns (uint32[] memory) {
        return _laneOddsBps;
    }

    function getRaceOdds(uint256 raceId) external view returns (uint32[] memory) {
        return _raceOdds[raceId];
    }

    function getRevelacion() external view returns (uint256 pool, uint16 bps, uint32 odds) {
        return (revelacionPool, revelacionBps, revelacionOdds);
    }

    function getBetLimits() external view returns (uint256, uint256, uint16) {
        return (minBet, maxBet, maxBetsPerRace);
    }

    function quotePayout(uint8 lane, uint256 netStake) external view returns (uint256) {
        if (lane >= _laneOddsBps.length) return 0;
        return _payoutFor(netStake, _laneOddsBps[lane]);
    }
}
