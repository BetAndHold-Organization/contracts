// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {PullVRFGame} from "../base/PullVRFGame.sol";
import {RandomDeriveLib} from "../../libraries/RandomDeriveLib.sol";
import {IBlackjackTableGame} from "../../interfaces/games/blackjack/IBlackjackTableGame.sol";
import {BlackjackTableLib} from "./libraries/BlackjackTableLib.sol";

/**
 * @title BlackjackTableGame
 * @notice Classic live-casino blackjack tables: up to seven seats against one
 *         dealer, dealt from one shared shoe, on the PullVRFGame base.
 *
 *         Per round:
 *           1. The operator opens the round on a table with
 *              `commit = keccak256(serverSeed)` — before any bet.
 *           2. Players take seats with their bet (`placeBet`, or `placeBetFor`
 *              relayed with a session-key signature). A player may register a
 *              one-round `actionSigner`: a throwaway browser key that signs the
 *              seat's play without wallet popups. The player's AuthHub session key
 *              is snapshotted into the seat: revoking or replacing it afterwards
 *              never invalidates (nor enables) a signature for that seat.
 *           3. The operator closes betting (`lockRound`): ONE random word is
 *              requested from the platform's RandomProvider.
 *           4. Cards come from `seed = keccak256(serverSeed ‖ vrfWord ‖ roundId ‖ this)`;
 *              the backend runs the table off-chain, seat by seat. Extra money
 *              (double / split / insurance) is pulled on-chain with `addWager`.
 *              Every action the player takes is signed at once (EIP-712 SeatPlay
 *              over the seat's log so far).
 *           5. The operator settles with every seat's log: the contract checks the
 *              commit, the word and each signature, accepts only STAND /
 *              INSURE_NO after a seat's signed prefix (timeouts), REPLAYS the whole
 *              table with BlackjackTableLib and pays every seat. The operator can
 *              never invent a hit, a double or a split, nor misreport a payout.
 *
 *         Payouts are computed on GROSS wagers; PaymentHandler fees are paid by the
 *         game out of its rules edge. Nobody's cooperation is needed to settle; a
 *         round that is never settled is refunded after `refundTimeout` — and if its
 *         random word was there to settle it, every seat gets what was reserved for it.
 */
contract BlackjackTableGame is PullVRFGame, IBlackjackTableGame {
    using ECDSA for bytes32;

    bytes32 public constant PLACE_BET_TYPEHASH = keccak256(
        "PlaceBet(address game,address player,uint256 roundId,uint8 seat,uint128 stake,uint128 sideBet,address potentialReferrer,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant ADD_WAGER_TYPEHASH = keccak256(
        "AddWager(address game,address player,uint256 roundId,uint8 seat,uint8 kind,uint256 nonce,uint256 deadline)"
    );

    /// @dev Player attestation of a seat's action log so far. Not a relayed
    ///      action: no nonce (bound to roundId + seat, which settle once).
    bytes32 public constant SEAT_PLAY_TYPEHASH = keccak256(
        "SeatPlay(address game,address player,uint256 roundId,uint8 seat,bytes32 actionsHash)"
    );

    uint8 public constant RULES_VERSION = BlackjackTableLib.RULES_VERSION;
    uint8 public constant MAX_SEATS = BlackjackTableLib.MAX_SEATS;
    /// @dev Tables open on demand; the bankroll (exposure lock), not this cap, is the real limit.
    uint8 public constant MAX_TABLES = 64;
    uint16 internal constant BPS = 10_000;

    // ═══════════════════════════════════════════════════════════════════════
    //                              ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error GameDisabled();
    error InvalidConfig();
    error InvalidTable(uint8 tableId);
    error TableBusy(uint8 tableId, uint256 roundId);
    error InvalidCommit();
    error InvalidRound();
    error InvalidSeat(uint8 seat);
    error SeatTakenAlready(uint8 seat);
    error ActiveRoundExists(uint256 roundId);
    error NoSeatsTaken();
    error BetTooLow(uint256 provided, uint256 min);
    error BetTooHigh(uint256 provided, uint256 max);
    error SideBetTooHigh(uint256 provided, uint256 max);
    error Unauthorized();
    error RandomNotReady();
    error RandomAlreadyFulfilled();
    error WagerAlreadyAdded();
    error WagerConflict();
    error BadPlays();
    error InvalidSeatSignature(uint8 seat);
    error UnsignedAction(uint8 seat, uint256 index);
    error PayoutExceedsLock(uint256 payout, uint256 locked);
    error TimeoutNotReached();
    error InsufficientFreeLiquidity(uint256 available, uint256 requested);
    error NotConfigManager();

    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════

    TableConfig public tableConfig;
    uint256 public nextRoundId = 1;
    mapping(uint256 => Round) internal _rounds;
    mapping(uint256 => mapping(uint8 => Seat)) internal _seats;
    /// @notice The round currently open or being played on each table (0 = none).
    mapping(uint8 => uint256) public currentRoundOf;
    /// @notice The round a player is seated in (0 = none). One seat at a time.
    mapping(address => uint256) public activeRoundOf;
    /// @notice Accounts that may change the table config (limits, tables, seats, timeouts,
    ///         enabled) without being the owner. They cannot move funds or change roles.
    mapping(address => bool) public configManagers;

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(
        address eva,
        address handler,
        address provider,
        address authHub,
        address initialOperator
    ) PullVRFGame(eva, handler, provider, authHub, "BlackjackTableGame", "1", initialOperator) {
        tableConfig = TableConfig({
            enabled: false,
            tables: 1,
            seats: MAX_SEATS,
            minBet: 0,
            maxBet: 0,
            maxSideBet: 0,
            settleTimeout: 10 minutes,
            refundTimeout: 1 hours
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    function setConfigManager(address account, bool status) external onlyOwner {
        require(account != address(0), "account");
        configManagers[account] = status;
        emit ConfigManagerSet(account, status);
    }

    /// @notice Owner or a config manager.
    function setTableConfig(TableConfig calldata cfg) external {
        if (msg.sender != owner() && !configManagers[msg.sender]) revert NotConfigManager();
        if (cfg.minBet == 0 || cfg.maxBet < cfg.minBet) revert InvalidConfig();
        if (cfg.tables == 0 || cfg.tables > MAX_TABLES || cfg.seats == 0 || cfg.seats > MAX_SEATS) revert InvalidConfig();
        if (cfg.settleTimeout == 0 || cfg.refundTimeout < cfg.settleTimeout) revert InvalidConfig();
        tableConfig = cfg;
        emit TableConfigUpdated(cfg.enabled, cfg.tables, cfg.seats, cfg.minBet, cfg.maxBet, cfg.maxSideBet, cfg.settleTimeout, cfg.refundTimeout);
    }

    /// @notice Withdraw bankroll that is not reserved for live rounds (house profit).
    function withdrawHouseFunds(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "to");
        uint256 balance = evaToken.balanceOf(address(this));
        uint256 free = balance > lockedExposure ? balance - lockedExposure : 0;
        if (amount > free) revert InsufficientFreeLiquidity(free, amount);
        _payPlayer(to, amount);
        emit HouseFundsWithdrawn(to, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              OPEN / BET / LOCK
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Open a betting round on a table, publishing the server-seed commit first.
    function openRound(uint8 tableId, bytes32 commit) external onlyGameOperator nonReentrant whenNotPaused returns (uint256 roundId) {
        TableConfig memory cfg = tableConfig;
        if (!cfg.enabled) revert GameDisabled();
        if (tableId >= cfg.tables) revert InvalidTable(tableId);
        if (commit == bytes32(0)) revert InvalidCommit();
        uint256 current = currentRoundOf[tableId];
        if (current != 0) revert TableBusy(tableId, current);

        roundId = nextRoundId++;
        Round storage r = _rounds[roundId];
        r.tableId = tableId;
        r.status = RoundStatus.Open;
        r.openedAt = uint40(block.timestamp);
        r.commit = commit;
        currentRoundOf[tableId] = roundId;
        emit RoundOpened(roundId, tableId, commit);
    }

    function placeBet(
        uint256 roundId,
        uint8 seat,
        uint128 stake,
        uint128 sideBet,
        address potentialReferrer,
        address actionSigner
    ) external nonReentrant whenNotPaused {
        _placeBet(msg.sender, roundId, seat, stake, sideBet, potentialReferrer, actionSigner);
    }

    function placeBetFor(
        address player,
        uint256 roundId,
        uint8 seat,
        uint128 stake,
        uint128 sideBet,
        address potentialReferrer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOperator nonReentrant whenNotPaused {
        bytes32 structHash = keccak256(
            abi.encode(PLACE_BET_TYPEHASH, address(this), player, roundId, seat, stake, sideBet, potentialReferrer, nonce, deadline)
        );
        _verifyAndConsume(player, address(this), uint256(stake) + uint256(sideBet), structHash, deadline, nonce, signature);
        // QuickBet: the session key signs the play, no extra round key needed.
        _placeBet(player, roundId, seat, stake, sideBet, potentialReferrer, address(0));
    }

    function _placeBet(
        address player,
        uint256 roundId,
        uint8 seat,
        uint128 stake,
        uint128 sideBet,
        address potentialReferrer,
        address actionSigner
    ) internal {
        Round storage r = _rounds[roundId];
        if (r.status != RoundStatus.Open) revert InvalidRound();
        TableConfig memory cfg = tableConfig;
        if (!cfg.enabled) revert GameDisabled();
        if (seat >= cfg.seats) revert InvalidSeat(seat);
        if (r.seatMask & (uint8(1) << seat) != 0) revert SeatTakenAlready(seat);
        if (stake < cfg.minBet) revert BetTooLow(stake, cfg.minBet);
        if (stake > cfg.maxBet) revert BetTooHigh(stake, cfg.maxBet);
        if (sideBet > cfg.maxSideBet) revert SideBetTooHigh(sideBet, cfg.maxSideBet);
        uint256 prev = activeRoundOf[player];
        if (prev != 0) {
            RoundStatus ps = _rounds[prev].status;
            if (ps == RoundStatus.Open || ps == RoundStatus.Locked) revert ActiveRoundExists(prev);
        }

        (, address payoutTarget, , , , ) = paymentHandler.getGameConfig(address(this));
        if (payoutTarget != address(this)) revert PaymentHandlerMisconfigured();

        uint256 gross = uint256(stake) + uint256(sideBet);
        uint256 netStake = _collectAndProcessBet(player, potentialReferrer, gross);
        require(netStake > 0, "net zero");

        // Natural pays 3:2 on top of the returned stake. The side bet only reserves its own
        // refund: Perfect Pairs wins are paid from the free bankroll at settle (every seat
        // hitting a pair at once is not a case worth locking the bankroll for).
        uint256 locked = (uint256(stake) * 5) / 2 + uint256(sideBet);
        _lockExposure(locked, 0);
        r.locked += locked;
        r.seatMask |= uint8(1) << seat;
        r.seatCount += 1;
        r.lastBetAt = uint40(block.timestamp);

        _seats[roundId][seat] = Seat({
            player: player,
            stake: stake,
            sideBet: sideBet,
            actionSigner: actionSigner,
            // Snapshot: a key revoked, expired or replaced after the bet can neither block the
            // settle (the old signatures stay valid) nor sign for the seat (the new one is not here).
            sessionKey: authHub.sessionKeyOf(player),
            doubled: false,
            split: false,
            insured: false
        });
        activeRoundOf[player] = roundId;

        emit SeatTaken(roundId, seat, player, stake, sideBet, actionSigner, r.locked);
        // Standard envelope (IGameEvents). betId = roundId * 8 + seat; data = abi.encode(roundId, seat, stake, sideBet)
        emit BetPlaced(_betId(roundId, seat), player, gross, abi.encode(roundId, seat, uint256(stake), uint256(sideBet)));
    }

    /// @notice Close betting and request the round's random word.
    function lockRound(uint256 roundId) external onlyGameOperator nonReentrant {
        Round storage r = _rounds[roundId];
        if (r.status != RoundStatus.Open) revert InvalidRound();
        if (r.seatCount == 0) revert NoSeatsTaken();

        // Close betting before the external call (checks-effects-interactions).
        r.status = RoundStatus.Locked;
        r.lockedAt = uint40(block.timestamp);

        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = RandomDeriveLib.Range({min: 0, max: uint128(BPS)});
        uint256 requestId = randomProvider.requestRandomNumbers(ranges);
        r.requestId = requestId;
        emit RoundLocked(roundId, requestId, r.seatCount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              ADD WAGER
    // ═══════════════════════════════════════════════════════════════════════

    function addWager(uint256 roundId, uint8 seat, WagerKind kind) external nonReentrant {
        _addWagerInternal(msg.sender, roundId, seat, kind);
    }

    function addWagerFor(
        address player,
        uint256 roundId,
        uint8 seat,
        WagerKind kind,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOperator nonReentrant {
        bytes32 structHash = keccak256(
            abi.encode(ADD_WAGER_TYPEHASH, address(this), player, roundId, seat, uint8(kind), nonce, deadline)
        );
        uint256 amount = _wagerAmount(_seats[roundId][seat].stake, kind);
        _verifyAndConsume(player, address(this), amount, structHash, deadline, nonce, signature);
        _addWagerInternal(player, roundId, seat, kind);
    }

    function _wagerAmount(uint128 stake, WagerKind kind) internal pure returns (uint256) {
        return kind == WagerKind.Insurance ? uint256(stake) / 2 : uint256(stake);
    }

    function _addWagerInternal(address player, uint256 roundId, uint8 seat, WagerKind kind) internal {
        Round storage r = _rounds[roundId];
        if (r.status != RoundStatus.Locked) revert InvalidRound();
        Seat storage s = _seats[roundId][seat];
        if (s.player != player || player == address(0)) revert Unauthorized();

        if (kind == WagerKind.Double) {
            if (s.doubled) revert WagerAlreadyAdded();
            if (s.split) revert WagerConflict();
            s.doubled = true;
        } else if (kind == WagerKind.Split) {
            if (s.split) revert WagerAlreadyAdded();
            if (s.doubled) revert WagerConflict();
            s.split = true;
        } else {
            if (s.insured) revert WagerAlreadyAdded();
            s.insured = true;
        }

        uint256 amount = _wagerAmount(s.stake, kind);
        // Collected only: the PaymentHandler fees are taken at settle on the part the play
        // consumed. A wager that is never played (or a round that is refunded) goes back gross,
        // so an unused wager cannot drain fees out of the bankroll (or into one's own referrer).
        _collectBet(player, amount);

        // Double: max return 2.5× → 4×. Split: two 1:1 hands → 4×. Insurance: +1.5× on a dealer natural.
        uint256 extraLock = (uint256(s.stake) * 3) / 2;
        _lockExposure(extraLock, 0);
        r.locked += extraLock;

        emit WagerAdded(roundId, seat, player, kind, amount, r.locked);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              SETTLE
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Settle a played round: one entry per taken seat, ascending.
     *         Each seat's signed prefix must carry a valid SeatPlay signature;
     *         only STAND / INSURE_NO may follow it. The contract replays the
     *         whole table and pays every seat.
     */
    function settle(
        uint256 roundId,
        bytes32 serverSeed,
        SeatPlay[] calldata plays
    ) external onlyGameOperator nonReentrant returns (uint256 totalPayout) {
        Round memory r = _rounds[roundId];
        if (r.status != RoundStatus.Locked) revert InvalidRound();
        (BlackjackTableLib.Result memory res, uint256 vrfWord) = _replay(roundId, r, serverSeed, plays);
        // The main game always fits its lock; Perfect Pairs wins come on top, out of the free
        // bankroll — never out of what other live rounds have reserved.
        uint256 sidePayout = 0;
        for (uint256 i = 0; i < res.seats.length; i++) sidePayout += res.seats[i].sideBetPayout;
        if (res.totalPayout - sidePayout > r.locked) revert PayoutExceedsLock(res.totalPayout - sidePayout, r.locked);
        if (res.totalPayout > r.locked) {
            uint256 balance = evaToken.balanceOf(address(this));
            uint256 reservedByOthers = lockedExposure - r.locked;
            uint256 available = balance > reservedByOthers ? balance - reservedByOthers : 0;
            if (res.totalPayout > available) revert LiquidityShortfall(available, res.totalPayout);
        }

        _rounds[roundId].status = RoundStatus.Settled;
        currentRoundOf[r.tableId] = 0;
        _unlockExposure(r.locked, 0);

        for (uint256 i = 0; i < plays.length; i++) {
            uint8 seat = plays[i].seat;
            address player = _seats[roundId][seat].player;
            if (activeRoundOf[player] == roundId) activeRoundOf[player] = 0;
            BlackjackTableLib.SeatResult memory sr = res.seats[i];
            (, uint256 extras, ) = _seatAmounts(_seats[roundId][seat]);
            uint256 consumed = extras - sr.wagerRefund;
            if (consumed > 0) _processExtraWagerFees(roundId, seat, player, consumed);
            if (sr.payout > 0) _payPlayer(player, sr.payout);
            bytes memory outcome = abi.encode(sr);
            emit SeatSettled(roundId, seat, player, sr.payout, plays[i].actions, plays[i].signedLen, outcome);
            // Standard envelope (IGameEvents). data = abi.encode(roundId, seat, actions, outcome)
            emit BetSettled(_betId(roundId, seat), player, sr.payout, abi.encode(roundId, seat, plays[i].actions, outcome));
        }
        emit RoundSettled(roundId, r.tableId, serverSeed, vrfWord, res.dealerCards, res.totalPayout);
        return res.totalPayout;
    }

    /// @dev Checks commit, word, seat coverage and every seat's signed prefix + auto suffix, then replays the table.
    function _replay(
        uint256 roundId,
        Round memory r,
        bytes32 serverSeed,
        SeatPlay[] calldata plays
    ) internal view returns (BlackjackTableLib.Result memory res, uint256 vrfWord) {
        if (serverSeed == bytes32(0) || keccak256(abi.encodePacked(serverSeed)) != r.commit) revert InvalidCommit();
        vrfWord = _readRandomWord(r.requestId);
        if (vrfWord == 0) revert RandomNotReady();
        if (plays.length != r.seatCount) revert BadPlays();

        BlackjackTableLib.SeatInput[] memory inputs = new BlackjackTableLib.SeatInput[](plays.length);
        bytes[] memory logs = new bytes[](plays.length);
        for (uint256 i = 0; i < plays.length; i++) {
            SeatPlay calldata p = plays[i];
            if (r.seatMask & (uint8(1) << p.seat) == 0 || (i > 0 && p.seat <= plays[i - 1].seat)) revert BadPlays();
            Seat memory s = _seats[roundId][p.seat];
            _checkSeatPlay(roundId, s, p);
            inputs[i] = BlackjackTableLib.SeatInput({
                seat: p.seat,
                stake: s.stake,
                sideBet: s.sideBet,
                doubled: s.doubled,
                split: s.split,
                insured: s.insured
            });
            logs[i] = p.actions;
        }
        bytes32 seed = keccak256(abi.encodePacked(serverSeed, vrfWord, roundId, address(this)));
        res = BlackjackTableLib.play(seed, inputs, logs);
    }

    function _checkSeatPlay(uint256 roundId, Seat memory s, SeatPlay calldata p) internal view {
        if (p.signedLen > p.actions.length) revert BadPlays();
        if (p.signedLen > 0) {
            bytes32 structHash = keccak256(
                abi.encode(SEAT_PLAY_TYPEHASH, address(this), s.player, roundId, p.seat, keccak256(p.actions[:p.signedLen]))
            );
            address signer = _hashTypedDataV4(structHash).recover(p.signature);
            if (signer != s.player && signer != s.actionSigner && signer != s.sessionKey) {
                revert InvalidSeatSignature(p.seat);
            }
        }
        // Timeouts only: the operator may stand or decline insurance for the player, never more.
        for (uint256 k = p.signedLen; k < p.actions.length; k++) {
            uint8 a = uint8(p.actions[k]);
            if (a != BlackjackTableLib.STAND && a != BlackjackTableLib.INSURE_NO) revert UnsignedAction(p.seat, k);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              REFUNDS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Refund every seat of a round that will not be played.
     *         - operator: an Open round at any time (table closing, nobody else bet…),
     *           or a Locked round whose random word never arrived after `settleTimeout`;
     *         - anyone: an Open round with bets, `refundTimeout` after its last bet (an empty
     *           round is nobody's loss and stays with the operator), or a Locked round
     *           `refundTimeout` after the lock.
     *         A Locked round whose random word IS available could have been settled: if the
     *         operator let it expire anyway, every seat is paid what the round had reserved
     *         for it (FORFEITED) instead of its wagers — not settling is never the house's
     *         cheaper option. Without a word (EXPIRED / CLOSED) the wagers go back gross.
     */
    function cancelRound(uint256 roundId) external nonReentrant {
        Round memory r = _rounds[roundId];
        if (r.status != RoundStatus.Open && r.status != RoundStatus.Locked) revert InvalidRound();

        uint256 refundTimeout = uint256(tableConfig.refundTimeout);
        bool forfeit = false;
        if (r.status == RoundStatus.Locked) {
            uint256 since = uint256(r.lockedAt);
            if (block.timestamp >= since + refundTimeout) {
                forfeit = _readRandomWord(r.requestId) != 0;
            } else {
                if (!gameOperators[msg.sender]) revert TimeoutNotReached();
                if (block.timestamp < since + uint256(tableConfig.settleTimeout)) revert TimeoutNotReached();
                if (_readRandomWord(r.requestId) != 0) revert RandomAlreadyFulfilled();
            }
        } else if (!gameOperators[msg.sender]) {
            if (r.seatCount == 0 || block.timestamp < uint256(r.lastBetAt) + refundTimeout) revert TimeoutNotReached();
        }

        _rounds[roundId].status = RoundStatus.Refunded;
        if (currentRoundOf[r.tableId] == roundId) currentRoundOf[r.tableId] = 0;
        _unlockExposure(r.locked, 0);

        for (uint8 seat = 0; seat < MAX_SEATS; seat++) {
            if (r.seatMask & (uint8(1) << seat) == 0) continue;
            Seat memory s = _seats[roundId][seat];
            (uint256 wagered, , uint256 lockedFor) = _seatAmounts(s);
            uint256 refund = forfeit ? lockedFor : wagered;
            if (activeRoundOf[s.player] == roundId) activeRoundOf[s.player] = 0;
            _payPlayer(s.player, refund);
            emit SeatRefunded(roundId, seat, s.player, refund);
            emit BetFailed(_betId(roundId, seat), s.player, bytes32("REFUNDED"));
        }
        bytes32 reason = r.status == RoundStatus.Open ? bytes32("CLOSED") : (forfeit ? bytes32("FORFEITED") : bytes32("EXPIRED"));
        emit RoundRefunded(roundId, r.tableId, reason);
    }

    /// @dev Fees on the extra wagers a seat actually played. The handler pulls `amount` from this
    ///      contract and returns the net; if it refuses (game disabled there, player excluded…)
    ///      the settle still goes through and the fees simply stay in the bankroll.
    function _processExtraWagerFees(uint256 roundId, uint8 seat, address player, uint256 amount) internal {
        // slither-disable-next-line unused-return
        try paymentHandler.processDirectBetFromGame(player, address(0), amount) returns (uint256) {
        } catch {
            emit ExtraWagerFeeSkipped(roundId, seat, player, amount);
        }
    }

    /// @dev Gross wagers collected, the extra wagers among them, and what the round reserved
    ///      for the seat (summed over the seats, exactly `Round.locked`). Lives in the library
    ///      to keep this contract under the code-size limit.
    function _seatAmounts(Seat memory s) internal pure returns (uint256 wagered, uint256 extras, uint256 locked) {
        return BlackjackTableLib.seatAmounts(s.stake, s.sideBet, s.doubled, s.split, s.insured);
    }

    function _betId(uint256 roundId, uint8 seat) internal pure returns (uint256) {
        return roundId * 8 + seat;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              VIEWS
    // ═══════════════════════════════════════════════════════════════════════

    function getRound(uint256 roundId) external view returns (Round memory) {
        return _rounds[roundId];
    }

    function getSeat(uint256 roundId, uint8 seat) external view returns (Seat memory) {
        return _seats[roundId][seat];
    }

    /// @notice All seven seats of a round (empty seats have player = 0).
    function getSeats(uint256 roundId) external view returns (Seat[7] memory out) {
        for (uint8 i = 0; i < MAX_SEATS; i++) out[i] = _seats[roundId][i];
    }

    /// @notice Everything a seat has put into the round (stake, side bet and extras).
    function seatWagered(uint256 roundId, uint8 seat) external view returns (uint256 wagered) {
        (wagered, , ) = _seatAmounts(_seats[roundId][seat]);
    }
}
