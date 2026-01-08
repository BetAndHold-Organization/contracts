// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IRandomConsumer.sol";

interface IRandomProviderMinimal {
    function requestRandomNumber(uint256 maxNumber) external returns (uint256 requestId);
}

interface IPaymentHandler {
    function processDirectBetFromGame(address bettor, address potentialReferrer, uint256 baseCost)
        external
        returns (uint256 netAmount);
}

/**
 * @title ProgressiveJackpotV2
 * @dev Progressive jackpot with per-tier pots and entry-based probability scaling.
 *      
 *      Key changes from V1:
 *      - Each tier has its own pot balance
 *      - Probability scales with entries (not balance)
 *      - Fixed costs per tier
 *      - Consolations paid from Tier 9 pot
 *      - All funds distributed across tier pots based on configurable shares
 */
contract ProgressiveJackpotV2 is Ownable2Step, ReentrancyGuard, IRandomConsumer {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════
    
    uint256 public constant PROBABILITY_PRECISION = 10_000; // basis points
    uint256 public constant MAX_ENTRIES = 64;
    uint8 public constant TIER_COUNT = 9;
    uint8 private constant FIRST_TIER_OFFSET = 3; // outcomes[3] is tier 0, outcomes[4] is tier 1, ...
    uint8 private constant LAST_TIER_INDEX = 8;   // Tier 9 (index 8) - consolations come from here

    // ═══════════════════════════════════════════════════════════════════════
    // STRUCTS (Compatible with V1 where possible)
    // ═══════════════════════════════════════════════════════════════════════

    struct JackpotState {
        uint8 nextTierIndex;
        uint256 totalEntries;
        uint256 totalJackpotsWon;
        uint256 totalConsolationPaid;
        address lastWinner;
        uint256 lastWinTimestamp;
    }

    struct EntryRecord {
        address game;
        address player;
        uint256 betAmount;
        uint8 tierIndex;
        uint8 outcomeIndex;
        uint256 payout;
        uint256 timestamp;
    }

    // V1-compatible TierConfig (unused fields kept for ABI compatibility)
    struct TierConfig {
        uint256 prizeMetric;     // Unused in V2 (prize = pot balance)
        bool isTerminal;         // true for tier 9
        bool isPercent;          // Unused in V2
        uint256 fixedBetCost;    // Fixed cost to attempt this tier
        bool useDynamicCost;     // Unused in V2 (always false)
        uint16 costBps;          // Unused in V2
    }

    // NEW: Probability configuration per tier
    struct TierProbConfig {
        uint16 minProbBps;       // Starting probability (e.g., 20 = 0.2%)
        uint16 maxProbBps;       // Max probability (e.g., 2000 = 20%)
        uint16 incrementBps;     // Increase per entry (e.g., 4 = 0.04%)
    }

    // V1-compatible OutcomeConfig
    struct OutcomeConfig {
        bool enabled;                    // Whether this outcome is active
        uint8 tierAdvance;               // Tiers to advance on win
        uint8 tierResetTo;               // Reset tier if terminal
        uint16 consolationMultiplier;    // In bps (e.g., 12000 = 1.2x)
        bool awardsTier;                 // Whether this outcome awards a tier prize
    }

    struct GameConfig {
        bool enabled;
        OutcomeConfig[] outcomes;
        uint16 maxConsolationMultiplier;
        uint8 fallbackIdx;
        bool fallbackSet;
    }

    struct DirectBetConfig {
        bool enabled;
    }

    struct DirectBetRequest {
        address bettor;
        uint256 amount;
        uint8 tierIndex;
        bool settled;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STORAGE
    // ═══════════════════════════════════════════════════════════════════════

    IERC20 public immutable evaToken;
    IRandomProviderMinimal public randomProvider;

    // Core state
    JackpotState public jackpotState;
    TierConfig[] public tierConfigs;

    // NEW: Per-tier pot balances
    mapping(uint8 => uint256) public tierPotBalance;

    // NEW: Tier share distribution (sum must = 10000)
    uint16[9] public tierShareBps;

    // NEW: Per-tier probability config and state
    mapping(uint8 => TierProbConfig) public tierProbConfigs;
    mapping(uint8 => uint256) public tierCurrentProbBps;
    mapping(uint8 => uint256) public tierEntriesSinceWin;

    // NEW: Admin system
    mapping(address => bool) public isAdmin;

    // Game registrations
    mapping(address => GameConfig) private gameConfigs;
    mapping(address => bool) public registeredGames;
    address[] public gameList;

    // Direct bet config
    DirectBetConfig public directBetConfig;
    OutcomeConfig[] private directOutcomes;
    uint16 private directMaxConsolationMultiplier;
    mapping(uint256 => DirectBetRequest) private directBetRequests;
    mapping(uint256 => uint256) private directBetBaseCost;
    mapping(uint256 => uint256) private directBetMaxPayout;
    uint256 public lastDirectBetBaseCost;
    uint256 public lastDirectBetMaxPayout;
    address public paymentHandler;

    // Entry history
    mapping(uint256 => EntryRecord) public entryHistory;
    mapping(address => uint256[]) public playerEntries;
    uint256 public nextEntryId;

    // Fallback indices
    uint8 private directFallbackIdx;
    bool private directFallbackSet;

    // ═══════════════════════════════════════════════════════════════════════
    // EVENTS (V1-compatible + new)
    // ═══════════════════════════════════════════════════════════════════════

    // V1 events (unchanged signatures)
    event GameRegistered(address indexed game);
    event GameUpdated(address indexed game);
    event GameStatusChanged(address indexed game, bool enabled);
    event TierLadderUpdated(uint8 indexed index, uint256 prizeMetric, bool isPercent, bool isTerminal);
    event LadderReset(uint8 totalTiers);
    event FundsAdded(address indexed game, uint256 amount, uint256 newTotal);
    event DirectBetConfigured(bool enabled);
    event DirectBetRequested(uint256 indexed requestId, address indexed player, uint256 amount, uint8 tierIndex);
    event DirectBetSettled(uint256 indexed requestId, address indexed player, uint8 outcomeIndex, uint256 payout);
    event EntryProcessed(
        uint256 indexed entryId,
        address indexed game,
        address indexed player,
        uint8 tierIndex,
        uint8 outcomeIndex,
        uint256 payout
    );
    event TierWon(uint8 indexed tierIndex, address indexed player, uint256 payout);
    event JackpotWon(address indexed player, uint256 payout);
    event ConsolationPaid(address indexed player, uint256 payout, uint16 consolationMultiplier);

    // V2 new events
    event AdminStatusChanged(address indexed account, bool isAdmin);
    event TierProbabilityBoosted(uint8 indexed tierIndex, uint256 simulatedEntries, uint256 newProbBps);
    event TierProbabilityReset(uint8 indexed tierIndex, uint256 newProbBps);
    event TierProbConfigUpdated(uint8 indexed tierIndex, uint16 minProbBps, uint16 maxProbBps, uint16 incrementBps);
    event TierSharesUpdated(uint16[9] shares);
    event TierPotSeeded(uint8 indexed tierIndex, uint256 amount);
    event AdminFundsDistributed(address indexed admin, uint256 amount);

    // ═══════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════

    error InvalidGame(address game);
    error GameDisabled(address game);
    error InvalidProbabilityTable();
    error InvalidTierConfiguration();
    error ProbabilityOverflow();
    error UnauthorizedCaller();
    error InsufficientFunds();
    error InvalidShares();
    error NotAdmin();

    // ═══════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════

    modifier onlyAdmin() {
        if (!isAdmin[msg.sender] && msg.sender != owner()) revert NotAdmin();
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════

    constructor(address _evaToken, address _randomProvider) {
        require(_evaToken != address(0), "Invalid token");
        require(_randomProvider != address(0), "Invalid provider");
        evaToken = IERC20(_evaToken);
        randomProvider = IRandomProviderMinimal(_randomProvider);

        // Default shares: 6.25% each for tiers 1-8, 50% for tier 9
        for (uint8 i = 0; i < 8; i++) {
            tierShareBps[i] = 625;
        }
        tierShareBps[8] = 5000;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ADMIN MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    function setAdmin(address account, bool status) external onlyOwner {
        require(account != address(0), "Invalid address");
        isAdmin[account] = status;
        emit AdminStatusChanged(account, status);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TIER SHARE CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════

    function setTierShares(uint16[9] calldata shares) external onlyOwner {
        uint256 total;
        for (uint8 i = 0; i < 9; i++) {
            total += shares[i];
        }
        if (total != 10_000) revert InvalidShares();
        
        for (uint8 i = 0; i < 9; i++) {
            tierShareBps[i] = shares[i];
        }
        emit TierSharesUpdated(shares);
    }

    function getTierShares() external view returns (uint16[9] memory) {
        return tierShareBps;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PROBABILITY CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════

    function setTierProbConfig(
        uint8 tierIndex,
        uint16 minProbBps,
        uint16 maxProbBps,
        uint16 incrementBps
    ) external onlyOwner {
        require(tierIndex < TIER_COUNT, "Invalid tier");
        require(minProbBps <= maxProbBps, "min > max");
        require(maxProbBps <= PROBABILITY_PRECISION, "max > 100%");
        
        tierProbConfigs[tierIndex] = TierProbConfig({
            minProbBps: minProbBps,
            maxProbBps: maxProbBps,
            incrementBps: incrementBps
        });
        
        // Initialize current probability to min if not set
        if (tierCurrentProbBps[tierIndex] == 0) {
            tierCurrentProbBps[tierIndex] = minProbBps;
        }
        
        emit TierProbConfigUpdated(tierIndex, minProbBps, maxProbBps, incrementBps);
    }

    function setAllTierProbConfigs(
        uint16 minProbBps,
        uint16 maxProbBps,
        uint16 incrementBps
    ) external onlyOwner {
        require(minProbBps <= maxProbBps, "min > max");
        require(maxProbBps <= PROBABILITY_PRECISION, "max > 100%");
        
        for (uint8 i = 0; i < TIER_COUNT; i++) {
            tierProbConfigs[i] = TierProbConfig({
                minProbBps: minProbBps,
                maxProbBps: maxProbBps,
                incrementBps: incrementBps
            });
            
            if (tierCurrentProbBps[i] == 0) {
                tierCurrentProbBps[i] = minProbBps;
            }
            
            emit TierProbConfigUpdated(i, minProbBps, maxProbBps, incrementBps);
        }
    }

    function getTierProbability(uint8 tierIndex) external view returns (
        uint256 currentProbBps,
        uint256 entriesSinceWin,
        uint16 minProbBps,
        uint16 maxProbBps,
        uint16 incrementBps
    ) {
        require(tierIndex < TIER_COUNT, "Invalid tier");
        TierProbConfig memory config = tierProbConfigs[tierIndex];
        return (
            tierCurrentProbBps[tierIndex],
            tierEntriesSinceWin[tierIndex],
            config.minProbBps,
            config.maxProbBps,
            config.incrementBps
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ADMIN PROBABILITY BOOST
    // ═══════════════════════════════════════════════════════════════════════

    function boostTierProbability(uint8 tierIndex, uint256 simulatedEntries) external onlyAdmin {
        require(tierIndex < TIER_COUNT, "Invalid tier");
        
        TierProbConfig memory config = tierProbConfigs[tierIndex];
        uint256 boost = simulatedEntries * config.incrementBps;
        uint256 newProb = tierCurrentProbBps[tierIndex] + boost;
        
        if (newProb > config.maxProbBps) {
            newProb = config.maxProbBps;
        }
        
        tierCurrentProbBps[tierIndex] = newProb;
        tierEntriesSinceWin[tierIndex] += simulatedEntries;
        
        emit TierProbabilityBoosted(tierIndex, simulatedEntries, newProb);
    }

    function resetTierProbability(uint8 tierIndex) external onlyOwner {
        require(tierIndex < TIER_COUNT, "Invalid tier");
        
        uint16 minProb = tierProbConfigs[tierIndex].minProbBps;
        tierCurrentProbBps[tierIndex] = minProb;
        tierEntriesSinceWin[tierIndex] = 0;
        
        emit TierProbabilityReset(tierIndex, minProb);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TIER LADDER (V1-compatible)
    // ═══════════════════════════════════════════════════════════════════════

    function setTierLadder(TierConfig[] calldata tiers) external onlyOwner {
        require(tiers.length == TIER_COUNT, "Must have 9 tiers");
        
        delete tierConfigs;
        for (uint256 i = 0; i < tiers.length; i++) {
            tierConfigs.push(tiers[i]);
            emit TierLadderUpdated(uint8(i), tiers[i].prizeMetric, tiers[i].isPercent, tiers[i].isTerminal);
        }
        
        jackpotState.nextTierIndex = 0;
        emit LadderReset(uint8(tiers.length));
    }

    function getTierLadder() external view returns (TierConfig[] memory tiers) {
        tiers = new TierConfig[](tierConfigs.length);
        for (uint256 i = 0; i < tierConfigs.length; i++) {
            tiers[i] = tierConfigs[i];
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FUNDING
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Games call this to add funds (distributes to all tier pots)
    function addFunds(uint256 amount) external nonReentrant {
        if (!registeredGames[msg.sender]) revert UnauthorizedCaller();
        require(amount > 0, "Amount must be positive");

        evaToken.safeTransferFrom(msg.sender, address(this), amount);
        _distributeFunds(amount);
        
        emit FundsAdded(msg.sender, amount, _totalPotBalance());
    }

    /// @notice Admin function to add funds with share distribution
    function adminAddFunds(uint256 amount) external onlyAdmin nonReentrant {
        require(amount > 0, "Amount must be positive");
        
        evaToken.safeTransferFrom(msg.sender, address(this), amount);
        _distributeFunds(amount);
        
        emit AdminFundsDistributed(msg.sender, amount);
        emit FundsAdded(msg.sender, amount, _totalPotBalance());
    }

    /// @notice Owner can seed individual tier pots directly
    function seedTierPot(uint8 tierIndex, uint256 amount) external onlyOwner nonReentrant {
        require(tierIndex < TIER_COUNT, "Invalid tier");
        require(amount > 0, "Amount must be positive");
        
        evaToken.safeTransferFrom(msg.sender, address(this), amount);
        tierPotBalance[tierIndex] += amount;
        
        emit TierPotSeeded(tierIndex, amount);
    }

    function _distributeFunds(uint256 amount) internal {
        for (uint8 i = 0; i < TIER_COUNT; i++) {
            uint256 share = (amount * tierShareBps[i]) / 10_000;
            tierPotBalance[i] += share;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BALANCE VIEWS
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Get individual tier pot balance
    function getTierPotBalance(uint8 tierIndex) external view returns (uint256) {
        require(tierIndex < TIER_COUNT, "Invalid tier");
        return tierPotBalance[tierIndex];
    }

    /// @notice Get all tier pot balances
    function getAllTierPotBalances() external view returns (uint256[9] memory balances) {
        for (uint8 i = 0; i < TIER_COUNT; i++) {
            balances[i] = tierPotBalance[i];
        }
    }

    /// @notice V1-compatible: returns sum of all tier pots
    function getJackpotBalance() external view returns (uint256) {
        return _totalPotBalance();
    }

    function _totalPotBalance() internal view returns (uint256) {
        uint256 total;
        for (uint8 i = 0; i < TIER_COUNT; i++) {
            total += tierPotBalance[i];
        }
        return total;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // GAME MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    function registerGame(address game, OutcomeConfig[] calldata outcomes) external onlyOwner {
        if (game == address(0)) revert InvalidGame(game);
        _validateOutcomes(outcomes);

        GameConfig storage cfg = gameConfigs[game];
        delete cfg.outcomes;

        uint16 maxConsolation;
        for (uint256 i = 0; i < outcomes.length; i++) {
            cfg.outcomes.push(outcomes[i]);
            if (!outcomes[i].awardsTier && outcomes[i].consolationMultiplier > maxConsolation) {
                maxConsolation = outcomes[i].consolationMultiplier;
            }
        }

        cfg.enabled = true;
        cfg.maxConsolationMultiplier = maxConsolation;

        if (!registeredGames[game]) {
            registeredGames[game] = true;
            gameList.push(game);
            emit GameRegistered(game);
        } else {
            emit GameUpdated(game);
        }
    }

    function setGameStatus(address game, bool enabled) external onlyOwner {
        if (!registeredGames[game]) revert InvalidGame(game);
        gameConfigs[game].enabled = enabled;
        emit GameStatusChanged(game, enabled);
    }

    function setGameFallback(address game, uint8 idx) external onlyOwner {
        if (!registeredGames[game]) revert InvalidGame(game);
        GameConfig storage cfg = gameConfigs[game];
        require(idx < cfg.outcomes.length, "idx oob");
        OutcomeConfig storage oc = cfg.outcomes[idx];
        require(!oc.awardsTier && oc.consolationMultiplier == 0, "Not pure lose");
        cfg.fallbackIdx = idx;
        cfg.fallbackSet = true;
    }

    function getGameOutcomes(address game) external view returns (OutcomeConfig[] memory) {
        return gameConfigs[game].outcomes;
    }

    function getRegisteredGames() external view returns (address[] memory) {
        return gameList;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // DIRECT BET CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════════

    function configureDirectBet(bool enabled, OutcomeConfig[] calldata outcomes) external onlyOwner {
        _validateOutcomes(outcomes);
        
        delete directOutcomes;
        uint16 maxConsolation;
        for (uint256 i = 0; i < outcomes.length; i++) {
            directOutcomes.push(outcomes[i]);
            if (!outcomes[i].awardsTier && outcomes[i].consolationMultiplier > maxConsolation) {
                maxConsolation = outcomes[i].consolationMultiplier;
            }
        }
        directMaxConsolationMultiplier = maxConsolation;
        directBetConfig.enabled = enabled;
        
        emit DirectBetConfigured(enabled);
    }

    function setDirectFallback(uint8 idx) external onlyOwner {
        require(idx < directOutcomes.length, "idx oob");
        OutcomeConfig storage oc = directOutcomes[idx];
        require(!oc.awardsTier && oc.consolationMultiplier == 0, "Not pure lose");
        directFallbackIdx = idx;
        directFallbackSet = true;
    }

    function setPaymentHandler(address handler) external onlyOwner {
        require(handler != address(0), "Invalid handler");
        paymentHandler = handler;
    }

    function getCurrentDirectBetCost() external view returns (uint256) {
        return _computeTierCost(jackpotState.nextTierIndex);
    }

    function getDirectBetOutcomes() external view returns (OutcomeConfig[] memory outcomes) {
        outcomes = new OutcomeConfig[](directOutcomes.length);
        for (uint256 i = 0; i < directOutcomes.length; i++) {
            outcomes[i] = directOutcomes[i];
        }
    }

    function getLastDirectBetMaxPayout() external view returns (uint256) {
        return lastDirectBetMaxPayout;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CURRENT TIER INFO
    // ═══════════════════════════════════════════════════════════════════════

    function getCurrentTierInfo()
        external
        view
        returns (uint8 tierIndex, TierConfig memory tier, uint256 prizeAmount)
    {
        tierIndex = jackpotState.nextTierIndex;

        if (tierConfigs.length == 0) {
            tier = TierConfig({
                prizeMetric: 0,
                isTerminal: false,
                isPercent: false,
                fixedBetCost: 0,
                useDynamicCost: false,
                costBps: 0
            });
            return (tierIndex, tier, 0);
        }

        tier = tierConfigs[tierIndex];
        prizeAmount = tierPotBalance[tierIndex]; // V2: prize = pot balance
    }

    function ensurePayable(address game, uint256 betAmount) external view {
        if (!registeredGames[game]) revert InvalidGame(game);
        GameConfig storage cfg = gameConfigs[game];
        if (!cfg.enabled) revert GameDisabled(game);

        uint8 tierIndex = jackpotState.nextTierIndex;
        uint256 tierPrize = tierPotBalance[tierIndex];
        
        // Check tier pot can pay
        if (tierPrize == 0) revert InsufficientFunds();
        
        // Check tier 9 can pay max consolation
        if (cfg.maxConsolationMultiplier > 0) {
            uint256 maxConsolation = (betAmount * cfg.maxConsolationMultiplier) / 10_000;
            if (tierPotBalance[LAST_TIER_INDEX] < maxConsolation) revert InsufficientFunds();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CORE ENTRY PROCESSING
    // ═══════════════════════════════════════════════════════════════════════

    function processJackpotEntry(
        address player,
        uint256 betAmount,
        uint256 roll
    ) external nonReentrant returns (uint256 payout) {
        GameConfig storage cfg = gameConfigs[msg.sender];
        if (!registeredGames[msg.sender]) revert InvalidGame(msg.sender);
        if (!cfg.enabled) revert GameDisabled(msg.sender);
        if (cfg.outcomes.length == 0) revert InvalidProbabilityTable();
        if (roll >= PROBABILITY_PRECISION) revert ProbabilityOverflow();

        JackpotState storage state = jackpotState;
        uint8 tierIndex = state.nextTierIndex;
        
        // Increment probability for current tier
        _incrementTierProbability(tierIndex);
        
        uint8 outcomeIndex = _resolveOutcome(cfg.outcomes, roll, tierIndex, cfg.fallbackIdx, cfg.fallbackSet);
        OutcomeConfig memory outcome = cfg.outcomes[outcomeIndex];

        // Solvency checks
        bool awardThisTier = outcome.awardsTier && (outcomeIndex == FIRST_TIER_OFFSET + tierIndex);
        if (awardThisTier) {
            require(tierPotBalance[tierIndex] > 0, "Tier pot empty");
        } else if (outcome.consolationMultiplier > 0) {
            uint256 consolationAmount = (betAmount * outcome.consolationMultiplier) / 10_000;
            require(tierPotBalance[LAST_TIER_INDEX] >= consolationAmount, "Tier 9 pot underfunded");
        }

        payout = _handleOutcome(player, betAmount, tierIndex, outcomeIndex, outcome);

        uint256 entryId = nextEntryId++;
        entryHistory[entryId] = EntryRecord({
            game: msg.sender,
            player: player,
            betAmount: betAmount,
            tierIndex: tierIndex,
            outcomeIndex: outcomeIndex,
            payout: payout,
            timestamp: block.timestamp
        });
        playerEntries[player].push(entryId);

        state.totalEntries++;

        emit EntryProcessed(entryId, msg.sender, player, tierIndex, outcomeIndex, payout);
        return payout;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // DIRECT BETTING
    // ═══════════════════════════════════════════════════════════════════════

    function placeDirectBet(address potentialReferrer) external nonReentrant returns (uint256 requestId) {
        address handler = paymentHandler;
        require(handler != address(0), "Handler not set");

        DirectBetConfig memory config = directBetConfig;
        require(config.enabled, "Direct betting disabled");
        require(directOutcomes.length > 0, "Direct outcomes not set");

        uint8 tierIndex = jackpotState.nextTierIndex;
        uint256 cost = _computeTierCost(tierIndex);
        require(cost > 0, "Cost unavailable");

        lastDirectBetBaseCost = cost;

        uint256 netAmount = IPaymentHandler(handler).processDirectBetFromGame(msg.sender, potentialReferrer, cost);
        require(netAmount <= cost, "Handler returned excess");

        // Distribute the net amount to tier pots
        _distributeFunds(netAmount);

        uint256 maxPayout = _computeMaxDirectBetPayout(netAmount, tierIndex);
        require(maxPayout > 0, "Max payout unavailable");

        // Solvency check
        require(tierPotBalance[tierIndex] > 0, "Tier pot empty");

        requestId = _createDirectBetRequest(msg.sender, netAmount, tierIndex);
        directBetBaseCost[requestId] = cost;
        directBetMaxPayout[requestId] = maxPayout;
        lastDirectBetMaxPayout = maxPayout;
    }

    function fulfillRandomness(
        uint256 requestId,
        uint256 /* randomWord */,
        uint256[] memory derivedValues
    ) external override {
        require(msg.sender == address(randomProvider), "Only provider");
        DirectBetRequest storage info = directBetRequests[requestId];
        if (info.bettor == address(0) || info.settled) {
            return;
        }

        require(derivedValues.length > 0, "No value");
        uint256 roll = derivedValues[0];

        // Increment probability for current tier
        _incrementTierProbability(info.tierIndex);

        uint8 outcomeIndex = _resolveOutcome(directOutcomes, roll, info.tierIndex, directFallbackIdx, directFallbackSet);
        OutcomeConfig memory outcome = directOutcomes[outcomeIndex];

        uint256 payout = _handleOutcome(info.bettor, info.amount, info.tierIndex, outcomeIndex, outcome);
        uint256 maxPayout = directBetMaxPayout[requestId];
        if (maxPayout == 0) {
            maxPayout = _computeMaxDirectBetPayout(info.amount, info.tierIndex);
        }
        require(payout <= maxPayout, "Payout exceeds max");

        uint256 entryId = nextEntryId++;
        entryHistory[entryId] = EntryRecord({
            game: address(this),
            player: info.bettor,
            betAmount: info.amount,
            tierIndex: info.tierIndex,
            outcomeIndex: outcomeIndex,
            payout: payout,
            timestamp: block.timestamp
        });
        playerEntries[info.bettor].push(entryId);
        jackpotState.totalEntries++;

        emit EntryProcessed(entryId, address(this), info.bettor, info.tierIndex, outcomeIndex, payout);
        emit DirectBetSettled(requestId, info.bettor, outcomeIndex, payout);

        info.settled = true;
        delete directBetRequests[requestId];
        delete directBetBaseCost[requestId];
        delete directBetMaxPayout[requestId];
    }

    function handleRandomFailure(
        uint256 requestId,
        bytes32 /* reason */,
        bytes calldata /* details */
    ) external override {
        require(msg.sender == address(randomProvider), "Only provider");
        DirectBetRequest storage info = directBetRequests[requestId];
        if (info.bettor == address(0) || info.settled) {
            return;
        }

        // Refund from tier 9 pot (where most funds went)
        uint256 refundAmount = info.amount;
        if (tierPotBalance[LAST_TIER_INDEX] >= refundAmount) {
            tierPotBalance[LAST_TIER_INDEX] -= refundAmount;
            evaToken.safeTransfer(info.bettor, refundAmount);
        }
        
        info.settled = true;
        delete directBetRequests[requestId];
        delete directBetBaseCost[requestId];
        delete directBetMaxPayout[requestId];
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INTERNAL: PROBABILITY
    // ═══════════════════════════════════════════════════════════════════════

    function _incrementTierProbability(uint8 tierIndex) internal {
        TierProbConfig memory config = tierProbConfigs[tierIndex];
        if (config.incrementBps == 0) return;
        
        uint256 currentProb = tierCurrentProbBps[tierIndex];
        uint256 newProb = currentProb + config.incrementBps;
        
        if (newProb > config.maxProbBps) {
            newProb = config.maxProbBps;
        }
        
        tierCurrentProbBps[tierIndex] = newProb;
        tierEntriesSinceWin[tierIndex]++;
    }

    function _resetTierProbability(uint8 tierIndex) internal {
        uint16 minProb = tierProbConfigs[tierIndex].minProbBps;
        tierCurrentProbBps[tierIndex] = minProb;
        tierEntriesSinceWin[tierIndex] = 0;
        
        emit TierProbabilityReset(tierIndex, minProb);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INTERNAL: OUTCOME RESOLUTION
    // ═══════════════════════════════════════════════════════════════════════

    function _resolveOutcome(
        OutcomeConfig[] storage outcomes,
        uint256 roll,
        uint8 currentTier,
        uint8 fbIdx,
        bool fbSet
    ) internal view returns (uint8) {
        uint256 cumulative = 0;
        uint8 currentAwardIdx = FIRST_TIER_OFFSET + currentTier;

        for (uint8 i = 0; i < outcomes.length; i++) {
            OutcomeConfig storage oc = outcomes[i];
            if (!oc.enabled) continue;

            // Only consider the current tier's award slice
            if (oc.awardsTier && i != currentAwardIdx) continue;

            // Get probability based on outcome type
            uint16 p;
            if (oc.awardsTier) {
                // Tier award: use entry-based probability
                p = uint16(tierCurrentProbBps[currentTier]);
            } else {
                // Consolation: use fixed probability (stored in a simple way)
                // We'll use a default approach - consolations have fixed probs
                // This needs to be configured in the outcome
                p = _getConsolationProbability(i);
            }
            
            if (p == 0) continue;

            cumulative += p;
            if (roll < cumulative) return i;
        }

        if (fbSet) return fbIdx;
        revert InvalidProbabilityTable();
    }

    function _getConsolationProbability(uint8 outcomeIndex) internal pure returns (uint16) {
        // Fixed consolation probabilities
        // Outcome 1: 12% (1200 bps) for 1.2x
        // Outcome 2: 6% (600 bps) for 1.5x
        if (outcomeIndex == 1) return 1200;
        if (outcomeIndex == 2) return 600;
        return 0;
    }

    function _handleOutcome(
        address player,
        uint256 betAmount,
        uint8 tierIndex,
        uint8 outcomeIndex,
        OutcomeConfig memory outcome
    ) internal returns (uint256 payout) {
        JackpotState storage state = jackpotState;

        bool isCurrentTierAward = outcome.awardsTier && (outcomeIndex == FIRST_TIER_OFFSET + tierIndex);

        if (isCurrentTierAward) {
            payout = _awardTier(player, tierIndex, outcome);
            _updateProgression(state, tierIndex, outcome);
            _resetTierProbability(tierIndex);
            return payout;
        }

        if (outcome.consolationMultiplier > 0) {
            payout = (betAmount * outcome.consolationMultiplier) / 10_000;
            
            // Pay from tier 9 pot
            require(tierPotBalance[LAST_TIER_INDEX] >= payout, "Tier 9 underfunded");
            tierPotBalance[LAST_TIER_INDEX] -= payout;
            
            evaToken.safeTransfer(player, payout);
            state.totalConsolationPaid += payout;
            emit ConsolationPaid(player, payout, outcome.consolationMultiplier);
            return payout;
        }

        // Pure lose
        return 0;
    }

    function _awardTier(
        address player,
        uint8 tierIndex,
        OutcomeConfig memory outcome
    ) internal returns (uint256 payout) {
        require(tierIndex < tierConfigs.length, "Invalid tier");

        // Prize = tier pot balance
        payout = tierPotBalance[tierIndex];
        require(payout > 0, "Tier pot empty");
        
        // Empty the pot
        tierPotBalance[tierIndex] = 0;
        
        jackpotState.lastWinner = player;
        jackpotState.lastWinTimestamp = block.timestamp;

        evaToken.safeTransfer(player, payout);
        emit TierWon(tierIndex, player, payout);

        TierConfig memory tier = tierConfigs[tierIndex];
        if (outcome.tierAdvance == 0 || tier.isTerminal) {
            jackpotState.totalJackpotsWon++;
            emit JackpotWon(player, payout);
        }
    }

    function _updateProgression(
        JackpotState storage state,
        uint8 currentTier,
        OutcomeConfig memory outcome
    ) internal {
        if (!outcome.awardsTier) {
            return;
        }

        uint8 destination = currentTier + outcome.tierAdvance;
        if (outcome.tierAdvance == 0) destination = currentTier;

        if (destination >= tierConfigs.length) {
            state.nextTierIndex = outcome.tierResetTo;
        } else if (tierConfigs[currentTier].isTerminal) {
            state.nextTierIndex = outcome.tierResetTo;
        } else {
            state.nextTierIndex = destination;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INTERNAL: COST CALCULATION
    // ═══════════════════════════════════════════════════════════════════════

    function _computeTierCost(uint8 tierIndex) internal view returns (uint256) {
        if (tierConfigs.length == 0) return 0;
        if (tierIndex >= tierConfigs.length) tierIndex = uint8(tierConfigs.length - 1);
        
        // V2: Always use fixed cost
        return tierConfigs[tierIndex].fixedBetCost;
    }

    function _computeMaxDirectBetPayout(uint256 netAmount, uint8 tierIndex) internal view returns (uint256) {
        uint256 maxPayout;
        
        // Tier prize = pot balance
        if (tierIndex < TIER_COUNT) {
            uint256 tierPrize = tierPotBalance[tierIndex];
            if (tierPrize > maxPayout) {
                maxPayout = tierPrize;
            }
        }

        // Consolation payouts
        for (uint256 i = 0; i < directOutcomes.length; i++) {
            OutcomeConfig memory outcome = directOutcomes[i];
            if (outcome.awardsTier) continue;
            if (outcome.consolationMultiplier > 0) {
                uint256 consolation = (netAmount * outcome.consolationMultiplier) / 10_000;
                if (consolation > maxPayout) {
                    maxPayout = consolation;
                }
            }
        }

        return maxPayout;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INTERNAL: VALIDATION
    // ═══════════════════════════════════════════════════════════════════════

    function _validateOutcomes(OutcomeConfig[] calldata outcomes) internal pure {
        if (outcomes.length == 0) revert InvalidProbabilityTable();
    }

    function _createDirectBetRequest(address bettor, uint256 netAmount, uint8 tierIndex)
        private
        returns (uint256 requestId)
    {
        requestId = randomProvider.requestRandomNumber(PROBABILITY_PRECISION);
        directBetRequests[requestId] = DirectBetRequest({
            bettor: bettor,
            amount: netAmount,
            tierIndex: tierIndex,
            settled: false
        });

        emit DirectBetRequested(requestId, bettor, netAmount, tierIndex);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // VIEW HELPERS (V1-compatible)
    // ═══════════════════════════════════════════════════════════════════════

    function getJackpotState() external view returns (JackpotState memory) {
        return jackpotState;
    }

    function getPlayerEntries(address player) external view returns (uint256[] memory) {
        return playerEntries[player];
    }

    function getEntry(uint256 entryId) external view returns (EntryRecord memory) {
        return entryHistory[entryId];
    }

    // ═══════════════════════════════════════════════════════════════════════
    // EMERGENCY
    // ═══════════════════════════════════════════════════════════════════════

    function emergencyWithdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "Invalid address");
        uint256 bal = evaToken.balanceOf(address(this));
        uint256 amt = amount == 0 ? bal : amount;
        require(amt <= bal, "Insufficient balance");
        
        // Reset all tier pot balances to zero
        for (uint8 i = 0; i < TIER_COUNT; i++) {
            tierPotBalance[i] = 0;
        }
        
        evaToken.safeTransfer(to, amt);
    }
}

