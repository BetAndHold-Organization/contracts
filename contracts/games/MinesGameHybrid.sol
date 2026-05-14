// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PullVRFGame} from "./base/PullVRFGame.sol";
import {RandomDeriveLib} from "../libraries/RandomDeriveLib.sol";

/// @title MinesGameHybridV2
/// @notice Mines game on the PullVRFGame canonical base.
///         Uses commit-reveal + pull-model VRF: the player commits to a secret at startGame,
///         RandomProvider's push callback is a no-op (provided by PullVRFGame, prevents LINK
///         waste), and Mines.claim reads the VRF word later via _readRandomWord(requestId).
contract MinesGameHybridV2 is PullVRFGame {

    bytes32 public constant START_GAME_TYPEHASH = keccak256(
        "StartGame(address game,address player,uint256 wager,uint8 minesCount,address potentialReferrer,bytes32 commit,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant COMMIT_CLICKS_TYPEHASH = keccak256(
        "CommitClicks(address game,address player,uint256 requestId,bytes32 clickCommit,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant CLAIM_TYPEHASH = keccak256(
        "Claim(address game,address player,uint256 requestId,bytes32 secret,bytes32 clicksHash,bytes32 nonceCommit,uint256 nonce,uint256 deadline)"
    );

    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint16 internal constant MULTIPLIER_SCALE = 100; // 1.00x == 100 (hundredths)
    uint8 internal constant TOTAL_SPOTS = 21;

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONFIG
    // ═══════════════════════════════════════════════════════════════════════

    struct TableConfig {
        bool enabled;
        uint8 minMines;      // e.g. 3
        uint8 maxMines;      // e.g. 7
        uint256 minWager;
        uint256 maxWager;    // 0 = unlimited
        uint32 claimTimeout; // seconds after start when cancel is allowed
    }

    // multipliers[minesCount][safeClicks] => multiplier in hundredths (e.g. 20000 = 200.00x)
    mapping(uint8 => uint32[]) private multipliers;

    // ═══════════════════════════════════════════════════════════════════════
    //                              GAME STATE
    // ═══════════════════════════════════════════════════════════════════════

    enum GameStatus {
        None,
        Started
    }

    struct PendingGame {
        address player;
        uint256 wager;              // gross wager provided by user (used for commit binding)
        uint256 netStake;           // actual stake received by this contract (used for exposure + payout)
        uint256 lockedAmount;       // reserved worst-case payout for this game
        uint40 startedAt;
        uint8 minesCount;
        bytes32 commit;             // keccak256(secret, player, minesCount, wager)
        bytes32 clickCommit;        // keccak256(clicks, nonce, player) - two-phase commit for security
        GameStatus status;
    }

    struct ClaimOutcome {
        uint8 safeClicks;
        bool hitMine;
        uint32 tableMultiplier; // raw table multiplier (hundredths)
        uint256 payout;         // final payout after maintenance edge
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error GameDisabled();
    error InvalidMines(uint256 mines);
    error WagerTooLow(uint256 provided, uint256 required);
    error WagerTooHigh(uint256 provided, uint256 allowed);
    error Unauthorized();
    error InvalidCommit();
    error RandomNotReady();
    error InvalidClick(uint256 idx, uint256 spot);
    error DuplicateClick(uint256 spot);
    error TooManyClicks(uint256 provided, uint256 allowed);
    error NoMultiplierTable(uint256 mines);
    error InvalidMultiplierTable();
    error ExpiredNotReached();
    error InvalidRequest();
    error InvalidMaintenanceEdge(uint256 bps);
    error ClickCommitmentRequired();
    error ClickCommitmentMismatch();

    // ═══════════════════════════════════════════════════════════════════════
    //                              STATE
    // ═══════════════════════════════════════════════════════════════════════

    // randomProvider inherited from VRFGameBase via PullVRFGame.

    TableConfig public tableConfig;

    /// @notice Extra edge retained by the bankroll in bps (in addition to PaymentHandler fees).
    uint16 public maintenanceEdgeBps;

    /// @notice Minimum balance coverage required as a fraction of total locked exposure.
    /// 1000 = 10%, 10000 = 100% (conservative: full coverage).
    uint16 public minCoverageBps;

    mapping(uint256 => PendingGame) public games; // requestId => game
    mapping(address => uint256) public activeRequestIdByPlayer;

    /// @notice Fee in bps taken from payout when an operator resolves abandoned/expired games.
    ///         Paid to the calling game operator (msg.sender) as gas reimbursement.
    uint16 public resolveFeeBps;

    // Attestation authority for the player-driven `claim` path is the gameOperators
    // allowlist (inherited from GameLifecycleRoles via PullVRFGame). Any allowlisted
    // operator may sign the click-outcome attestation; verification goes through
    // `_verifyOperatorAttestation`. To split signing-only from tx-submission-only,
    // register two operator addresses with different key profiles.

    // ═══════════════════════════════════════════════════════════════════════
    //                              EVENTS
    // ═══════════════════════════════════════════════════════════════════════

    event TableConfigUpdated(
        bool enabled,
        uint8 minMines,
        uint8 maxMines,
        uint256 minWager,
        uint256 maxWager,
        uint32 claimTimeout
    );

    event MaintenanceEdgeUpdated(uint16 maintenanceEdgeBps);
    event MultiplierTableSet(uint8 minesCount, uint32[] multipliersHundredths);

    event GameStarted(
        uint256 indexed requestId,
        address indexed player,
        uint256 wager,
        uint256 netStake,
        uint8 minesCount,
        bytes32 commit,
        uint256 lockedAmount
    );

    event GameClaimed(
        uint256 indexed requestId,
        address indexed player,
        uint8 minesCount,
        uint8 safeClicks,
        bool hitMine,
        uint32 finalMultiplierHundredths,
        uint16 maintenanceEdgeBps,
        uint256 payout
    );

    /// @param refundAmount Refund paid to the player on cancellation. 0 when the cancel
    ///                     happens via `_cancelActiveGameIfAny` (start-of-new-game flow)
    ///                     or when `cancelExpired` is called with `refundPlayer=false`.
    ///                     Non-zero when `cancelExpired` is called with `refundPlayer=true`.
    event GameCanceled(uint256 indexed requestId, address indexed player, uint256 refundAmount);
    event ClickCommitmentMade(uint256 indexed requestId, address indexed player, bytes32 clickCommit);

    event ResolveFeeBpsUpdated(uint16 oldBps, uint16 newBps);

    // ═══════════════════════════════════════════════════════════════════════
    //                              CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(
        address eva,
        address handler,
        address provider,
        address authHub,
        address initialOperator
    )
        PullVRFGame(eva, handler, provider, authHub, "MinesGameHybridV2", "1", initialOperator)
    {
        // randomProvider, initialOperator seeding, and base/auth wiring all handled by PullVRFGame.
        // Note: initialOperator is also the default claim-attestation signer (verified via
        // gameOperators allowlist). Register additional operator addresses post-deploy if you
        // want to split signing-only from tx-submission keys.

        tableConfig = TableConfig({
            enabled: false,
            minMines: 3,
            maxMines: 7,
            minWager: 0,
            maxWager: 0,
            claimTimeout: 5 minutes
        });

        maintenanceEdgeBps = 100; // 1%
        emit MaintenanceEdgeUpdated(maintenanceEdgeBps);

        minCoverageBps = 1_000; // 10% coverage by default

        resolveFeeBps = 100; // 1%
        emit ResolveFeeBpsUpdated(0, 100);
    }

    // _paymentHandler() override provided by PullVRFGame.

    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    function setTableConfig(TableConfig calldata cfg) external onlyOwner {
        if (cfg.minMines < 1 || cfg.maxMines > TOTAL_SPOTS - 1 || cfg.maxMines < cfg.minMines) {
            revert InvalidMines(cfg.maxMines);
        }
        if (cfg.maxWager != 0 && cfg.maxWager < cfg.minWager) {
            revert WagerTooHigh(cfg.maxWager, cfg.minWager);
        }
        tableConfig = cfg;
        emit TableConfigUpdated(cfg.enabled, cfg.minMines, cfg.maxMines, cfg.minWager, cfg.maxWager, cfg.claimTimeout);
    }

    function setMaintenanceEdgeBps(uint16 bps) external onlyOwner {
        if (bps > 2_000) revert InvalidMaintenanceEdge(bps);
        maintenanceEdgeBps = bps;
        emit MaintenanceEdgeUpdated(bps);
    }

    function setMinCoverageBps(uint16 bps) external onlyOwner {
        require(bps > 0 && bps <= BPS_DENOMINATOR, "Invalid coverage bps");
        minCoverageBps = bps;
    }

    function setMultiplierTable(uint8 minesCount, uint32[] calldata multipliersHundredths) external onlyOwner {
        if (minesCount < 1 || minesCount >= TOTAL_SPOTS) revert InvalidMines(minesCount);

        uint8 maxSafe = TOTAL_SPOTS - minesCount;
        if (multipliersHundredths.length != uint256(maxSafe) + 1) revert InvalidMultiplierTable();

        if (multipliersHundredths[0] < MULTIPLIER_SCALE) revert InvalidMultiplierTable();
        for (uint256 i = 1; i < multipliersHundredths.length; i++) {
            if (multipliersHundredths[i] < multipliersHundredths[i - 1]) revert InvalidMultiplierTable();
        }

        delete multipliers[minesCount];
        for (uint256 i = 0; i < multipliersHundredths.length; i++) {
            multipliers[minesCount].push(multipliersHundredths[i]);
        }

        emit MultiplierTableSet(minesCount, multipliersHundredths);
    }

    function setResolveFeeBps(uint16 bps) external onlyOwner {
        require(bps <= 1_000, "Cap 10%");
        uint16 old = resolveFeeBps;
        resolveFeeBps = bps;
        emit ResolveFeeBpsUpdated(old, bps);
    }

    // No `setOracleSigner` — the claim-attestation signer is any address on the
    // gameOperators allowlist. Use the inherited setGameOperator/setGameOperators
    // (from PullVRFGame) to manage signers.

    // ═══════════════════════════════════════════════════════════════════════
    //                              CORE GAME
    // ═══════════════════════════════════════════════════════════════════════

    function startGame(
        uint256 wager,
        uint8 minesCount,
        address potentialReferrer,
        bytes32 commit
    ) external nonReentrant returns (uint256 requestId) {
        return _startGameInternal(msg.sender, wager, minesCount, potentialReferrer, commit);
    }

    function startGameFor(
        address player,
        uint256 wager,
        uint8 minesCount,
        address potentialReferrer,
        bytes32 commit,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOperator nonReentrant returns (uint256 requestId) {
        bytes32 structHash = keccak256(
            abi.encode(
                START_GAME_TYPEHASH,
                address(this),
                player,
                wager,
                minesCount,
                potentialReferrer,
                commit,
                nonce,
                deadline
            )
        );
        _verifyAndConsume(player, address(this), wager, structHash, deadline, nonce, signature);
        return _startGameInternal(player, wager, minesCount, potentialReferrer, commit);
    }

    function _startGameInternal(
        address bettor,
        uint256 wager,
        uint8 minesCount,
        address potentialReferrer,
        bytes32 commit
    ) internal returns (uint256 requestId) {
        TableConfig memory cfg = tableConfig;
        if (!cfg.enabled) revert GameDisabled();
        if (commit == bytes32(0)) revert InvalidCommit();

        if (minesCount < cfg.minMines || minesCount > cfg.maxMines) revert InvalidMines(minesCount);
        if (cfg.minWager > 0 && wager < cfg.minWager) revert WagerTooLow(wager, cfg.minWager);
        if (cfg.maxWager > 0 && wager > cfg.maxWager) revert WagerTooHigh(wager, cfg.maxWager);

        (, address payoutTarget, , , , ) = paymentHandler.getGameConfig(address(this));
        if (payoutTarget != address(this)) revert PaymentHandlerMisconfigured();

        uint32[] storage table = multipliers[minesCount];
        if (table.length == 0) revert NoMultiplierTable(minesCount);

        _cancelActiveGameIfAny(bettor);

        uint256 netStake = _collectAndProcessBet(bettor, potentialReferrer, wager);
        require(netStake > 0, "net zero");

        RandomDeriveLib.Range[] memory ranges = new RandomDeriveLib.Range[](1);
        ranges[0] = RandomDeriveLib.Range({min: 0, max: uint128(BPS_DENOMINATOR)});
        requestId = randomProvider.requestRandomNumbers(ranges);

        if (games[requestId].status != GameStatus.None) revert InvalidRequest();

        uint256 lockedAmount = _computeLockedAmount(netStake, minesCount, table);

        // Per-bet coverage: worst-case payout for THIS bet must be fully backed by
        // current balance. Cumulative leverage (minCoverageBps) still applies across
        // all concurrent games via _lockMinesExposure below.
        uint256 currentBal = evaToken.balanceOf(address(this));
        if (lockedAmount > currentBal) revert LiquidityShortfall(currentBal, lockedAmount);

        // Jackpot share is routed by PaymentHandler at bet entry; this game only locks the player payout.
        _lockMinesExposure(lockedAmount);

        games[requestId] = PendingGame({
            player: bettor,
            wager: wager,
            netStake: netStake,
            lockedAmount: lockedAmount,
            startedAt: uint40(block.timestamp),
            minesCount: minesCount,
            commit: commit,
            clickCommit: bytes32(0),
            status: GameStatus.Started
        });

        activeRequestIdByPlayer[bettor] = requestId;

        emit GameStarted(requestId, bettor, wager, netStake, minesCount, commit, lockedAmount);
        // Standard envelope (IGameEvents). data = abi.encode(netStake, minesCount, commit, lockedAmount)
        emit BetPlaced(
            requestId,
            bettor,
            wager,
            abi.encode(netStake, minesCount, commit, lockedAmount)
        );
        return requestId;
    }

    function commitToClicks(uint256 requestId, bytes32 clickCommit) external nonReentrant {
        _commitToClicksInternal(msg.sender, requestId, clickCommit);
    }

    function commitToClicksFor(
        address player,
        uint256 requestId,
        bytes32 clickCommit,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOperator nonReentrant {
        bytes32 structHash = keccak256(
            abi.encode(
                COMMIT_CLICKS_TYPEHASH,
                address(this),
                player,
                requestId,
                clickCommit,
                nonce,
                deadline
            )
        );
        _verifyAndConsume(player, address(this), 0, structHash, deadline, nonce, signature);
        _commitToClicksInternal(player, requestId, clickCommit);
    }

    function _commitToClicksInternal(address player, uint256 requestId, bytes32 clickCommit) internal {
        PendingGame storage g = games[requestId];
        if (g.status != GameStatus.Started) revert InvalidRequest();
        if (g.player != player) revert Unauthorized();
        if (clickCommit == bytes32(0)) revert InvalidCommit();
        if (g.clickCommit != bytes32(0)) revert InvalidRequest();

        g.clickCommit = clickCommit;

        emit ClickCommitmentMade(requestId, player, clickCommit);
    }

    function claim(uint256 requestId, bytes32 secret, uint8[] calldata clicks, bytes32 nonce, bytes calldata attestationSig) external nonReentrant {
        _claimInternal(msg.sender, requestId, secret, clicks, nonce, attestationSig);
    }

    function claimFor(
        address player,
        uint256 requestId,
        bytes32 secret,
        uint8[] calldata clicks,
        bytes32 nonceCommit,
        bytes calldata attestationSig,
        uint256 authNonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyOperator nonReentrant {
        bytes32 structHash = keccak256(
            abi.encode(
                CLAIM_TYPEHASH,
                address(this),
                player,
                requestId,
                secret,
                keccak256(abi.encodePacked(clicks)),
                nonceCommit,
                authNonce,
                deadline
            )
        );
        _verifyAndConsume(player, address(this), 0, structHash, deadline, authNonce, signature);
        _claimInternal(player, requestId, secret, clicks, nonceCommit, attestationSig);
    }

    function _claimInternal(
        address player,
        uint256 requestId,
        bytes32 secret,
        uint8[] calldata clicks,
        bytes32 nonce,
        bytes calldata attestationSig
    ) internal {
        PendingGame memory g = games[requestId];
        if (g.status != GameStatus.Started) revert InvalidRequest();
        if (g.player != player) revert Unauthorized();

        // Verify the click-outcome attestation: signature must recover to an address
        // currently on the gameOperators allowlist (inherited from GameLifecycleRoles
        // via PullVRFGame).
        {
            bytes32 sigHash = keccak256(abi.encodePacked(requestId, secret, clicks));
            _verifyOperatorAttestation(sigHash, attestationSig);
        }

        if (g.clickCommit == bytes32(0)) revert ClickCommitmentRequired();

        {
            bytes32 expectedCommit = keccak256(abi.encodePacked(clicks, nonce, player));
            if (expectedCommit != g.clickCommit) revert ClickCommitmentMismatch();
        }

        if (
            secret == bytes32(0) ||
            keccak256(abi.encodePacked(secret, g.player, g.minesCount, g.wager)) != g.commit
        ) revert InvalidCommit();

        uint256 vrfWord = _readRandomWord(requestId);
        if (vrfWord == 0) revert RandomNotReady();

        if (clicks.length > TOTAL_SPOTS - g.minesCount) revert TooManyClicks(clicks.length, TOTAL_SPOTS - g.minesCount);

        ClaimOutcome memory out = _resolveClaim(requestId, g, secret, vrfWord, clicks);

        _unlockMinesExposure(g.lockedAmount);
        delete games[requestId];

        if (activeRequestIdByPlayer[player] == requestId) {
            activeRequestIdByPlayer[player] = 0;
        }

        if (out.payout > 0) {
            _payPlayer(player, out.payout);
        }

        emit GameClaimed(
            requestId,
            player,
            g.minesCount,
            out.safeClicks,
            out.hitMine,
            out.tableMultiplier,
            maintenanceEdgeBps,
            out.payout
        );
        // Standard envelope (IGameEvents). data = abi.encode(minesCount, safeClicks, hitMine, tableMultiplier, maintenanceEdgeBps)
        emit BetSettled(
            requestId,
            player,
            out.payout,
            abi.encode(g.minesCount, out.safeClicks, out.hitMine, out.tableMultiplier, maintenanceEdgeBps)
        );
    }

    function resolveAbandoned(
        uint256 requestId,
        bytes32 secret,
        uint8[] calldata clicks
    ) external onlyGameOperator nonReentrant {
        PendingGame memory g = games[requestId];
        if (g.status != GameStatus.Started) revert InvalidRequest();

        uint256 deadline = uint256(g.startedAt) + uint256(tableConfig.claimTimeout);
        if (block.timestamp < deadline) revert ExpiredNotReached();

        if (
            secret == bytes32(0) ||
            keccak256(abi.encodePacked(secret, g.player, g.minesCount, g.wager)) != g.commit
        ) revert InvalidCommit();

        uint256 vrfWord = _readRandomWord(requestId);
        if (vrfWord == 0) revert RandomNotReady();

        uint8 maxSafe = TOTAL_SPOTS - g.minesCount;
        if (clicks.length > maxSafe) revert TooManyClicks(clicks.length, maxSafe);

        ClaimOutcome memory out = _resolveClaim(requestId, g, secret, vrfWord, clicks);

        _unlockMinesExposure(g.lockedAmount);
        delete games[requestId];

        if (activeRequestIdByPlayer[g.player] == requestId) {
            activeRequestIdByPlayer[g.player] = 0;
        }

        uint256 fee = 0;
        if (out.payout > 0 && resolveFeeBps > 0) {
            fee = Math.mulDiv(out.payout, resolveFeeBps, BPS_DENOMINATOR);
            _payPlayer(msg.sender, fee);
            _payPlayer(g.player, out.payout - fee);
        } else if (out.payout > 0) {
            _payPlayer(g.player, out.payout);
        }

        emit GameClaimed(
            requestId,
            g.player,
            g.minesCount,
            out.safeClicks,
            out.hitMine,
            out.tableMultiplier,
            maintenanceEdgeBps,
            out.payout - fee
        );
        // Standard envelope (IGameEvents). data = abi.encode(minesCount, safeClicks, hitMine, tableMultiplier, maintenanceEdgeBps, fee)
        emit BetSettled(
            requestId,
            g.player,
            out.payout - fee,
            abi.encode(g.minesCount, out.safeClicks, out.hitMine, out.tableMultiplier, maintenanceEdgeBps, fee)
        );
    }

    function cancelExpired(uint256 requestId, bool refundPlayer) external onlyGameOperator nonReentrant {
        PendingGame memory g = games[requestId];
        if (g.status != GameStatus.Started) revert InvalidRequest();

        uint256 deadline = uint256(g.startedAt) + uint256(tableConfig.claimTimeout);
        if (block.timestamp < deadline) revert ExpiredNotReached();

        _unlockMinesExposure(g.lockedAmount);
        delete games[requestId];

        if (activeRequestIdByPlayer[g.player] == requestId) {
            activeRequestIdByPlayer[g.player] = 0;
        }

        uint256 refundPaid = 0;
        if (refundPlayer) {
            uint256 refund = Math.mulDiv(g.netStake, uint256(BPS_DENOMINATOR - maintenanceEdgeBps), BPS_DENOMINATOR);
            if (refund > 0) {
                uint256 fee = resolveFeeBps > 0 ? Math.mulDiv(refund, resolveFeeBps, BPS_DENOMINATOR) : 0;
                if (fee > 0) {
                    _payPlayer(msg.sender, fee);
                }
                refundPaid = refund - fee;
                _payPlayer(g.player, refundPaid);
            }
        }

        emit GameCanceled(requestId, g.player, refundPaid);
        // Standard envelope (IGameEvents). cancelExpired is a controlled-state cancellation,
        // surfaced as BetFailed with a CANCELED tag so indexers can join the bet lifecycle.
        emit BetFailed(requestId, g.player, bytes32("CANCELED_EXPIRED"));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              VIEWS
    // ═══════════════════════════════════════════════════════════════════════

    function getMultiplierTable(uint8 minesCount) external view returns (uint32[] memory) {
        return multipliers[minesCount];
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              INTERNALS
    // ═══════════════════════════════════════════════════════════════════════

    function _cancelActiveGameIfAny(address player) internal {
        uint256 prevId = activeRequestIdByPlayer[player];
        if (prevId == 0) return;

        PendingGame memory g = games[prevId];

        if (g.status != GameStatus.Started) {
            activeRequestIdByPlayer[player] = 0;
            return;
        }

        if (g.player != player) {
            return;
        }

        _unlockMinesExposure(g.lockedAmount);
        delete games[prevId];
        activeRequestIdByPlayer[player] = 0;

        // Implicit cancellation from start-of-new-game has no refund.
        emit GameCanceled(prevId, player, 0);
        // Standard envelope: prior game implicitly cancelled when the player starts a new one.
        emit BetFailed(prevId, player, bytes32("CANCELED_NEW_GAME"));
    }

    function _computeLockedAmount(
        uint256 netStake,
        uint8 minesCount,
        uint32[] storage table
    ) internal view returns (uint256 lockedAmount) {
        uint8 maxSafe = TOTAL_SPOTS - minesCount;
        uint32 maxMult = table[uint256(maxSafe)];

        uint256 effectiveMaxMult = Math.mulDiv(
            uint256(maxMult),
            uint256(BPS_DENOMINATOR - maintenanceEdgeBps),
            uint256(BPS_DENOMINATOR)
        );

        lockedAmount = Math.mulDiv(netStake, effectiveMaxMult, MULTIPLIER_SCALE);
    }

    function _resolveClaim(
        uint256 requestId,
        PendingGame memory g,
        bytes32 secret,
        uint256 vrfWord,
        uint8[] calldata clicks
    ) internal view returns (ClaimOutcome memory out) {
        bytes32 seed = keccak256(abi.encodePacked(secret, vrfWord, requestId, address(this)));
        uint32 mineBitmap = _deriveMineBitmap(seed, g.minesCount);

        uint32 clicked = 0;

        for (uint256 i = 0; i < clicks.length; i++) {
            uint8 spot = clicks[i];
            if (spot >= TOTAL_SPOTS) revert InvalidClick(i, spot);

            uint32 mask = uint32(1) << spot;
            if ((clicked & mask) != 0) revert DuplicateClick(spot);
            clicked |= mask;

            if ((mineBitmap & mask) != 0) {
                out.hitMine = true;
                return out;
            }

            out.safeClicks++;
        }

        uint32[] storage table = multipliers[g.minesCount];
        out.tableMultiplier = table[uint256(out.safeClicks)];

        uint256 preEdge = Math.mulDiv(g.netStake, uint256(out.tableMultiplier), MULTIPLIER_SCALE);
        out.payout = Math.mulDiv(preEdge, uint256(BPS_DENOMINATOR - maintenanceEdgeBps), BPS_DENOMINATOR);
    }

    /// @dev Mines uses fractional coverage: balance must cover (minCoverageBps / 10000)
    ///      of total locked exposure, allowing leveraged bankroll.
    function _lockMinesExposure(uint256 amount) internal {
        uint256 newTotal = lockedExposure + amount;
        uint256 bal = evaToken.balanceOf(address(this));
        uint256 minRequired = Math.mulDiv(newTotal, minCoverageBps, BPS_DENOMINATOR);
        if (bal < minRequired) revert LiquidityShortfall(bal, minRequired);
        lockedExposure = newTotal;
    }

    function _unlockMinesExposure(uint256 amount) internal {
        if (lockedExposure <= amount) lockedExposure = 0;
        else lockedExposure -= amount;
    }

    function _deriveMineBitmap(bytes32 seed, uint8 minesCount) internal pure returns (uint32 mineBitmap) {
        uint8[TOTAL_SPOTS] memory arr;
        for (uint8 i = 0; i < TOTAL_SPOTS; i++) {
            arr[i] = i;
        }

        uint256 remaining = TOTAL_SPOTS;
        bytes32 s = seed;

        for (uint8 i = 0; i < minesCount; i++) {
            s = keccak256(abi.encodePacked(s, i));
            uint256 j = uint256(s) % remaining;

            uint8 picked = arr[uint8(j)];
            mineBitmap |= (uint32(1) << picked);

            remaining--;
            arr[uint8(j)] = arr[uint8(remaining)];
        }
    }
}
