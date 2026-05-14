// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {PushVRFGame} from "./base/PushVRFGame.sol";
import {RandomDeriveLib} from "../libraries/RandomDeriveLib.sol";

/// @title Plinko
/// @notice On-chain Plinko game on the PushVRFGame canonical base.
/// @dev Uses bit extraction from words produced by RandomDeriveLib.deriveWordSequence(VRF seed).
///      Inherits all platform invariants from PushVRFGame (token, handler, exposure, pause,
///      emergencyWithdraw, VRF, auth, lifecycle, event envelope).
contract Plinko is PushVRFGame {
    // --- Constants ---

    bytes32 public constant PLACE_BET_TYPEHASH = keccak256(
        "PlaceBet(address game,address player,uint256 betAmount,uint8 rows,uint8 risk,uint8 numDrops,address potentialReferrer,uint256 nonce,uint256 deadline)"
    );

    uint256 public constant MULTIPLIER_SCALE = 100;
    uint8 public constant MIN_ROWS = 4;
    uint8 public constant MAX_ROWS = 32;
    uint8 public constant MAX_DROPS = 100;
    uint16 private constant BITS_PER_WORD = 256;
    /// @notice Hard ceiling for maxPendingBetsPerPlayer — owner cannot raise it above this.
    uint8 public constant MAX_PENDING_BETS_PER_PLAYER_CAP = 10;

    // --- Enums & Structs ---

    enum RiskLevel {
        Low,
        Medium,
        High
    }

    /// @dev Fields ordered to pack player+rows+risk+numDrops+exists+placedAtBlock into one
    ///   32-byte slot (20+1+1+1+1+8 = 32 bytes). Total layout: 5 slots.
    struct PendingBet {
        address player; // 20 bytes ─┐
        uint8 rows; //  1 byte   │ slot 1 (32 bytes)
        RiskLevel risk; //  1 byte   │
        uint8 numDrops; //  1 byte   │
        bool exists; //  1 byte   │
        uint64 placedAtBlock; //  8 bytes ─┘
        uint256 betAmount; // slot 2
        uint256 totalWager; // slot 3
        uint256 maxPayout; // slot 4
        uint256 netStake; // slot 5 — net amount after fees, used for potential on-chain refund
    }

    // --- Errors ---

    error InvalidRows(uint8 rows);
    error RowsNotAllowed(uint8 rows);
    error InvalidNumDrops(uint8 numDrops);
    error WagerTooLow(uint256 provided, uint256 required);
    error WagerTooHigh(uint256 provided, uint256 allowed);
    error MultipliersNotSet(uint8 rows, RiskLevel risk);
    error InvalidMultiplierLength(uint256 expected, uint256 actual);
    error MultipliersNotSymmetric();
    /// @notice Thrown when a multiplier value of zero is provided.
    /// @param index Position in the multiplier array that is zero.
    error ZeroMultiplier(uint256 index);
    error BetNotFound(uint256 requestId);
    error InvalidBetLimits(uint256 minBet, uint256 maxBet);
    error InvalidMaxDrops(uint8 maxDrops);
    /// @notice Thrown when attempting to cancel a bet whose expiry window has not yet elapsed.
    error BetNotExpired(uint256 requestId, uint256 expiryBlock);
    /// @notice Thrown when betExpiryBlocks is set to an invalid value.
    error InvalidExpiryBlocks(uint256 blocks);
    /// @notice Thrown when a player already has the maximum number of pending bets.
    /// @param player  The player address that hit the cap.
    /// @param limit   The current cap value.
    error TooManyPendingBets(address player, uint256 limit);
    /// @notice Thrown when maxPendingBetsPerPlayer is set to zero or above MAX_PENDING_BETS_PER_PLAYER_CAP.
    error InvalidPendingBetLimit(uint8 limit);
    /// @notice Thrown when the system-wide pending bets cap is reached.
    /// @param current Current total pending bets across all players.
    /// @param limit   The system-wide cap value.
    error TotalPendingBetsCap(uint256 current, uint256 limit);
    /// @notice Thrown when maxTotalPendingBets is set to zero.
    error InvalidTotalPendingBetsLimit();

    // --- Events ---

    event BetPlaced(
        uint256 indexed requestId,
        address indexed player,
        uint256 betAmount,
        uint8 rows,
        RiskLevel risk,
        uint8 numDrops,
        uint256 totalWager,
        uint256 maxPayout
    );

    event BetSettled(
        uint256 indexed requestId,
        address indexed player,
        uint256 totalPayout,
        uint8 numDrops,
        uint8[] slots,
        uint256 randomWord
    );

    // BetFailed inherited from IGameEvents (via PushVRFGame) — same signature.

    event MultipliersUpdated(uint8 rows, RiskLevel risk);
    event AllowedRowsUpdated(uint8[] rows);
    event BetLimitsUpdated(uint256 minBet, uint256 maxBet);
    event MaxDropsUpdated(uint8 maxDrops);
    event BetExpiryBlocksUpdated(uint256 blocks);
    event MaxPendingBetsPerPlayerUpdated(uint8 limit);
    event MaxTotalPendingBetsUpdated(uint256 newMax);
    // PaymentHandlerUpdated is inherited from BaseGame and fired by the inherited setter.

    // --- State ---

    /// @notice Multiplier tables: rows => risk => multipliers array
    mapping(uint8 => mapping(RiskLevel => uint256[])) private multiplierTables;

    /// @notice Cached max multiplier per config: rows => risk => maxMultiplier
    mapping(uint8 => mapping(RiskLevel => uint256)) public maxMultipliers;

    /// @notice Pending bets awaiting VRF callback
    mapping(uint256 => PendingBet) public pendingBets;

    /// @notice Which row counts are allowed
    mapping(uint8 => bool) public allowedRows;

    /// @notice List of allowed row counts (for enumeration)
    uint8[] public allowedRowsList;

    uint256 public minBet;
    uint256 public maxBet;
    uint8 public maxDropsPerBet = 10;
    /// @notice Maximum number of unresolved pending bets a single player may hold.
    /// @dev Packed with maxDropsPerBet in the same storage slot.
    uint8 public maxPendingBetsPerPlayer = 5;

    /// @notice Number of blocks after which an unresolved pending bet can be cancelled.
    /// @dev Default is 86 400 blocks ≈ 6 hours on Arbitrum (~250 ms/block).
    ///   Owner should tune this based on the VRF provider's expected worst-case latency.
    uint256 public betExpiryBlocks = 86_400;

    /// @notice Tracks how many pending bets each player currently holds.
    mapping(address => uint256) public pendingBetCount;

    /// @notice System-wide count of all unresolved pending bets across all players.
    /// @dev Incremented in placeBet; decremented in fulfillRandomness, handleRandomFailure,
    ///   and cancelExpiredBet. Guards against multi-wallet liquidity-squeeze attacks (H-3).
    uint256 public totalPendingBets;

    /// @notice Maximum number of unresolved pending bets allowed across the entire system.
    /// @dev Owner-configurable. Prevents a multi-wallet attacker from draining
    ///   availableLiquidity() by spreading pending bets across many addresses.
    uint256 public maxTotalPendingBets = 50;

    // --- Constructor ---

    /// @param handler  Address of the PaymentHandler contract.
    /// @param provider Address of the RandomProvider contract.
    /// @param eva      Address of the EVA ERC-20 token.
    /// @param _minBet  Minimum total wager per bet (0 = no lower limit).
    /// @param _maxBet  Maximum total wager per bet (0 = no upper limit).
    ///                 If both are non-zero, _minBet must be ≤ _maxBet.
    constructor(
        address handler,
        address provider,
        address eva,
        address authHub,
        address initialOperator,
        uint256 _minBet,
        uint256 _maxBet
    )
        PushVRFGame(eva, handler, provider, authHub, "Plinko", "1", initialOperator)
    {
        if (_minBet > 0 && _maxBet > 0 && _minBet > _maxBet)
            revert InvalidBetLimits(_minBet, _maxBet);
        minBet = _minBet;
        maxBet = _maxBet;
        // initialOperator seeded by PushVRFGame.
    }

    // --- View Functions ---

    /// @notice Returns the multiplier table for a given row count and risk level.
    function getMultipliers(
        uint8 rows,
        RiskLevel risk
    ) external view returns (uint256[] memory) {
        return multiplierTables[rows][risk];
    }

    /// @notice Returns the list of allowed row counts.
    function getAllowedRows() external view returns (uint8[] memory) {
        return allowedRowsList;
    }

    // --- Core Gameplay ---

    /// @notice Place a Plinko bet with one or more drops.
    /// @param betAmount Per-drop wager amount (pre-fee).
    /// @param rows Number of rows on the board.
    /// @param risk Risk level (Low, Medium, High).
    /// @param numDrops Number of balls to drop.
    /// @param potentialReferrer Referrer address (or zero).
    /// @return requestId The VRF request ID.
    function placeBet(
        uint256 betAmount,
        uint8 rows,
        RiskLevel risk,
        uint8 numDrops,
        address potentialReferrer
    ) external nonReentrant whenNotPaused returns (uint256 requestId) {
        return _placeBetInternal(msg.sender, betAmount, rows, risk, numDrops, potentialReferrer);
    }

    function placeBetFor(
        address player,
        uint256 betAmount,
        uint8 rows,
        RiskLevel risk,
        uint8 numDrops,
        address potentialReferrer,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOperator nonReentrant whenNotPaused returns (uint256 requestId) {
        uint256 totalWager = betAmount * numDrops;
        bytes32 structHash = keccak256(
            abi.encode(
                PLACE_BET_TYPEHASH,
                address(this),
                player,
                betAmount,
                rows,
                uint8(risk),
                numDrops,
                potentialReferrer,
                nonce,
                deadline
            )
        );
        _verifyAndConsume(player, address(this), totalWager, structHash, deadline, nonce, signature);
        return _placeBetInternal(player, betAmount, rows, risk, numDrops, potentialReferrer);
    }

    function _placeBetInternal(
        address bettor,
        uint256 betAmount,
        uint8 rows,
        RiskLevel risk,
        uint8 numDrops,
        address potentialReferrer
    ) internal returns (uint256 requestId) {
        if (!allowedRows[rows]) revert RowsNotAllowed(rows);
        if (numDrops == 0 || numDrops > maxDropsPerBet)
            revert InvalidNumDrops(numDrops);
        if (pendingBetCount[bettor] >= maxPendingBetsPerPlayer)
            revert TooManyPendingBets(bettor, maxPendingBetsPerPlayer);
        if (totalPendingBets >= maxTotalPendingBets)
            revert TotalPendingBetsCap(totalPendingBets, maxTotalPendingBets);

        uint256[] memory mults = multiplierTables[rows][risk];
        if (mults.length == 0) revert MultipliersNotSet(rows, risk);

        uint256 totalWager = betAmount * numDrops;
        if (minBet > 0 && totalWager < minBet)
            revert WagerTooLow(totalWager, minBet);
        if (maxBet > 0 && totalWager > maxBet)
            revert WagerTooHigh(totalWager, maxBet);

        // Compute max possible payout
        uint256 maxPayout = (betAmount *
            maxMultipliers[rows][risk] *
            numDrops) / MULTIPLIER_SCALE;

        // CEI: increment counters before external calls
        pendingBetCount[bettor]++;
        totalPendingBets++;

        // V5 payment flow: pull from player into this contract, then forward to handler.
        // Player must have approved this game contract (not PaymentHandler directly).
        uint256 netStake = _collectAndProcessBet(
            bettor,
            potentialReferrer,
            totalWager
        );

        // Lock liquidity for this bet's max payout. Checks balance post-payment.
        _lockExposure(maxPayout, 0);

        // V5 VRF API: requestRandomNumbers with a Range array.
        // Plinko uses the raw randomWord for bit extraction and ignores derivedValues,
        // so a single dummy range [0, 2) is sufficient.
        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = RandomDeriveLib.Range({min: 0, max: 2});
        requestId = randomProvider.requestRandomNumbers(ranges);

        // Written after VRF call (requestId is return value). Safe: nonReentrant.
        pendingBets[requestId] = PendingBet({
            player: bettor,
            betAmount: betAmount,
            totalWager: totalWager,
            maxPayout: maxPayout,
            netStake: netStake,
            rows: rows,
            risk: risk,
            numDrops: numDrops,
            exists: true,
            placedAtBlock: uint64(block.number)
        });

        emit BetPlaced(
            requestId,
            bettor,
            betAmount,
            rows,
            risk,
            numDrops,
            totalWager,
            maxPayout
        );
        // Standard envelope (IGameEvents) — for cross-game indexing.
        // data = abi.encode(betAmount, rows, risk, numDrops, maxPayout)
        emit BetPlaced(
            requestId,
            bettor,
            totalWager,
            abi.encode(betAmount, rows, uint8(risk), numDrops, maxPayout)
        );
    }

    /// @notice VRF callback — settles bet via bit extraction from deriveWordSequence(randomWord).
    /// @dev derivedValues unused. Word stream matches BurningGames RandomDeriveLib (chained keccak per index).
    function fulfillRandomness(
        uint256 requestId,
        uint256 randomWord,
        uint256[] memory /* derivedValues — intentionally unused, see @dev */
    ) external override nonReentrant onlyRandomProvider {
        PendingBet memory bet = pendingBets[requestId];
        if (!bet.exists) revert BetNotFound(requestId);

        // Unlock exposure and clean up
        _unlockExposure(bet.maxPayout, 0);
        delete pendingBets[requestId];
        pendingBetCount[bet.player]--;
        totalPendingBets--;

        uint256[] memory mults = multiplierTables[bet.rows][bet.risk];

        uint8[] memory slots = new uint8[](bet.numDrops);
        uint256 totalPayout;

        {
            uint256 rows = uint256(bet.rows);
            uint256 totalBitsNeeded = uint256(bet.numDrops) * rows;
            uint256 wordCount = (totalBitsNeeded + uint256(BITS_PER_WORD) - 1) /
                uint256(BITS_PER_WORD);
            (uint256[] memory words, ) = RandomDeriveLib.deriveWordSequence(
                randomWord,
                wordCount
            );

            uint256 totalBitsUsed = 0;

            for (uint256 d = 0; d < bet.numDrops; d++) {
                uint256 wordIndex = totalBitsUsed >> 8;
                uint256 bitIndex = totalBitsUsed & 0xFF;

                uint32 chunk;
                if (bitIndex + rows <= BITS_PER_WORD) {
                    chunk = uint32(
                        (words[wordIndex] >> bitIndex) & ((1 << rows) - 1)
                    );
                } else {
                    uint256 bitsFromCurrent = BITS_PER_WORD - bitIndex;
                    uint256 lo = words[wordIndex] >> bitIndex;
                    uint256 hi = words[wordIndex + 1] &
                        ((1 << (rows - bitsFromCurrent)) - 1);
                    chunk = uint32(lo | (hi << bitsFromCurrent));
                }

                slots[d] = _popcount32(chunk);
                totalBitsUsed += rows;
                totalPayout +=
                    (bet.betAmount * mults[slots[d]]) /
                    MULTIPLIER_SCALE;
            }
        }

        // Transfer payout using BaseGame helper
        if (totalPayout > 0) {
            _payPlayer(bet.player, totalPayout);
        }

        emit BetSettled(
            requestId,
            bet.player,
            totalPayout,
            bet.numDrops,
            slots,
            randomWord
        );
        // Standard envelope (IGameEvents). data = abi.encode(numDrops, slots, randomWord)
        emit BetSettled(
            requestId,
            bet.player,
            totalPayout,
            abi.encode(bet.numDrops, slots, randomWord)
        );
    }

    /// @notice VRF failure callback — unlocks exposure and closes the pending bet.
    /// @dev No on-chain refund; operator compensates off-chain via BetFailed events.
    function handleRandomFailure(
        uint256 requestId,
        bytes32 reason,
        bytes calldata /* details */
    ) external override nonReentrant onlyRandomProvider {
        PendingBet memory bet = pendingBets[requestId];
        if (!bet.exists) return;

        // Unlock the reserved exposure so future bets are not blocked.
        _unlockExposure(bet.maxPayout, 0);

        delete pendingBets[requestId];
        pendingBetCount[bet.player]--;
        totalPendingBets--;

        emit BetFailed(requestId, bet.player, reason);
    }

    // --- Admin Functions ---

    /// @notice Set multiplier table for a given row count and risk level.
    /// @dev Validates symmetry and caches max. Pause and clear pending bets before updating.
    ///   Multipliers use MULTIPLIER_SCALE: 250x payout = 25_000. See specs for overflow details.
    /// @param rows Number of rows.
    /// @param risk Risk level.
    /// @param mults Array of length rows+1, scaled by MULTIPLIER_SCALE. All entries must be > 0.
    function setMultipliers(
        uint8 rows,
        RiskLevel risk,
        uint256[] calldata mults
    ) external onlyOwner {
        if (rows < MIN_ROWS || rows > MAX_ROWS) revert InvalidRows(rows);
        if (mults.length != uint256(rows) + 1) {
            revert InvalidMultiplierLength(uint256(rows) + 1, mults.length);
        }

        // Validate symmetry: mults[k] == mults[rows - k]
        uint256 half = mults.length / 2;
        for (uint256 k = 0; k < half; k++) {
            if (mults[k] != mults[rows - k]) revert MultipliersNotSymmetric();
        }

        // Store and compute max; reject any zero entry
        multiplierTables[rows][risk] = mults;

        uint256 maxMult = 0;
        for (uint256 i = 0; i < mults.length; i++) {
            if (mults[i] == 0) revert ZeroMultiplier(i);
            if (mults[i] > maxMult) maxMult = mults[i];
        }
        maxMultipliers[rows][risk] = maxMult;

        emit MultipliersUpdated(rows, risk);
    }

    /// @notice Set which row counts are allowed for betting.
    /// @dev Reverts with `InvalidRows(0)` if `rows` is empty, preventing an
    ///   accidental silent disable of the entire game (use `pause()` instead).
    /// @param rows Non-empty array of allowed row counts (each in [MIN_ROWS, MAX_ROWS]).
    function setAllowedRows(uint8[] calldata rows) external onlyOwner {
        if (rows.length == 0) revert InvalidRows(0);

        // Clear existing
        uint256 len = allowedRowsList.length;
        for (uint256 i = 0; i < len; i++) {
            allowedRows[allowedRowsList[i]] = false;
        }
        delete allowedRowsList;

        // Set new — skip duplicates to keep allowedRowsList clean
        for (uint256 i = 0; i < rows.length; i++) {
            if (rows[i] < MIN_ROWS || rows[i] > MAX_ROWS)
                revert InvalidRows(rows[i]);
            if (allowedRows[rows[i]]) continue;
            allowedRows[rows[i]] = true;
            allowedRowsList.push(rows[i]);
        }

        emit AllowedRowsUpdated(allowedRowsList);
    }

    /// @notice Set minimum and maximum bet amounts (applied to totalWager).
    function setBetLimits(uint256 _minBet, uint256 _maxBet) external onlyOwner {
        if (_minBet > 0 && _maxBet > 0 && _minBet > _maxBet)
            revert InvalidBetLimits(_minBet, _maxBet);
        minBet = _minBet;
        maxBet = _maxBet;
        emit BetLimitsUpdated(_minBet, _maxBet);
    }

    /// @notice Set maximum drops per bet (1–MAX_DROPS).
    function setMaxDropsPerBet(uint8 _maxDrops) external onlyOwner {
        if (_maxDrops == 0 || _maxDrops > MAX_DROPS)
            revert InvalidMaxDrops(_maxDrops);
        maxDropsPerBet = _maxDrops;
        emit MaxDropsUpdated(_maxDrops);
    }

    /// @notice Set the number of blocks after which a pending bet can be cancelled.
    /// @param _blocks Must be greater than zero.
    function setBetExpiryBlocks(uint256 _blocks) external onlyOwner {
        if (_blocks == 0) revert InvalidExpiryBlocks(_blocks);
        betExpiryBlocks = _blocks;
        emit BetExpiryBlocksUpdated(_blocks);
    }

    /// @notice Set the maximum number of concurrent pending bets allowed per player.
    /// @dev Cannot exceed MAX_PENDING_BETS_PER_PLAYER_CAP to prevent the owner from
    ///   effectively disabling the per-player limit and enabling single-wallet DoS.
    /// @param _limit Must be between 1 and MAX_PENDING_BETS_PER_PLAYER_CAP (inclusive).
    function setMaxPendingBetsPerPlayer(uint8 _limit) external onlyOwner {
        if (_limit == 0 || _limit > MAX_PENDING_BETS_PER_PLAYER_CAP)
            revert InvalidPendingBetLimit(_limit);
        maxPendingBetsPerPlayer = _limit;
        emit MaxPendingBetsPerPlayerUpdated(_limit);
    }

    /// @notice Set the system-wide maximum number of unresolved pending bets.
    /// @dev Limits how much locked exposure can accumulate across all players,
    ///   protecting against multi-wallet liquidity-squeeze attacks (H-3).
    /// @param _limit Must be at least 1.
    function setMaxTotalPendingBets(uint256 _limit) external onlyOwner {
        if (_limit == 0) revert InvalidTotalPendingBetsLimit();
        maxTotalPendingBets = _limit;
        emit MaxTotalPendingBetsUpdated(_limit);
    }

    // setGameOperator / setGameOperators inherited from PushVRFGame.

    /// @notice Cancel a pending bet whose VRF request exceeded the expiry window.
    /// @dev Unlocks lockedExposure and removes the bet. No on-chain refund; operator compensates
    ///   off-chain via BetFailed events. Restricted to game operators (set by owner) to prevent
    ///   premature cancellation while keeping the cold owner key out of the day-to-day path.
    /// @param requestId The VRF request ID of the stuck pending bet.
    function cancelExpiredBet(
        uint256 requestId
    ) external onlyGameOperator nonReentrant {
        PendingBet memory bet = pendingBets[requestId];
        if (!bet.exists) revert BetNotFound(requestId);

        uint256 expiryBlock = uint256(bet.placedAtBlock) + betExpiryBlocks;
        if (block.number < expiryBlock)
            revert BetNotExpired(requestId, expiryBlock);

        _unlockExposure(bet.maxPayout, 0);
        delete pendingBets[requestId];
        pendingBetCount[bet.player]--;
        totalPendingBets--;

        emit BetFailed(requestId, bet.player, bytes32("EXPIRED"));
    }

    // Plinko uses BaseGame.emergencyWithdraw — non-virtual, always zeros lockedExposure.

    // --- Internal Helpers ---

    /// @notice Count set bits in a 32-bit integer (parallel prefix sum).
    /// @dev MAX_ROWS = 32, so the extracted chunk always fits in uint32.
    ///   unchecked is safe: step-1 subtraction never underflows (proven property),
    ///   and the final multiply intentionally overflows uint32 — only the top byte matters.
    function _popcount32(uint32 x) internal pure returns (uint8) {
        unchecked {
            x = x - ((x >> 1) & 0x55555555);
            x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
            x = (x + (x >> 4)) & 0x0F0F0F0F;
            return uint8((x * 0x01010101) >> 24);
        }
    }
}