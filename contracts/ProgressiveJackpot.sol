// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IRandomConsumer.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {JackpotScalingLib} from "./libraries/JackpotScalingLib.sol";
interface IRandomProviderMinimal {
    function requestRandomNumber(uint256 maxNumber) external returns (uint256 requestId);
}

interface IPaymentHandler {
    function processDirectBetFromGame(address bettor, address potentialReferrer, uint256 baseCost)
        external
        returns (uint256 netAmount);
}

/**
 * @title ProgressiveJackpot
 * @dev Configurable progressive jackpot pool that can be shared across multiple games.
 *      Games contribute funds via `addFunds` and submit outcome rolls via
 *      `processJackpotEntry`. Owner can adjust prize ladder and probabilities.
 */
contract ProgressiveJackpot is Ownable2Step, ReentrancyGuard, IRandomConsumer {
    using SafeERC20 for IERC20;

    // ---- Constants ----
    uint256 public constant PROBABILITY_PRECISION = 10_000; // basis points
    uint256 public constant MAX_ENTRIES = 64;
    uint16 public constant MAX_DIRECT_BET_HOUSE_EDGE_BPS = 1_000; // 10%

    // ---- Structs ----

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
    
    // Owner-configurable ladder of tiers that players progress through.
    struct TierConfig {
        uint256 prizeMetric; // basis points (if isPercent) or absolute EVA amount
        bool isTerminal;     // whether hitting this tier resets the ladder
        bool isPercent;      // true = prizeMetric is % of balance, false = fixed amount
        uint256 fixedBetCost; // cost in EVA to attempt this tier; 0 means derive dynamically
        bool useDynamicCost;  // when true, cost is derived from balance (prorated)
    }

    struct OutcomeConfig {
        JackpotScalingLib.ScalingConfig scaling; // probability slice (bps), can be constant or scaled
        uint8 tierAdvance;                       // number of tiers to advance on success
        uint8 tierResetTo;                       // new tier index if terminal (defaults to 0)
        uint16 consolationMultiplier;            // in bps, e.g., 15000 = 1.5x
        bool awardsTier;                         // whether this outcome awards a tier prize
    }

    // Each registered game defines its own outcome table. This allows
    // different games to plug into the same jackpot while keeping custom odds.
struct GameConfig {
    bool enabled;
    OutcomeConfig[] outcomes;
    uint16 maxConsolationMultiplier;
    uint8 fallbackIdx;     // index of pure-lose outcome for remainder
    bool fallbackSet;      // whether fallbackIdx is set
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

    // ---- Storage ----

    IERC20 public immutable evaToken;
    IRandomProviderMinimal public randomProvider;

    JackpotState public jackpotState;
    TierConfig[] public tierConfigs;

    mapping(address => GameConfig) private gameConfigs;
    mapping(address => bool) public registeredGames;
    address[] public gameList;

    DirectBetConfig public directBetConfig;
    OutcomeConfig[] private directOutcomes;
    uint16 private directMaxConsolationMultiplier;
    mapping(uint256 => DirectBetRequest) private directBetRequests;
    mapping(uint256 => uint256) private directBetBaseCost;
    mapping(uint256 => uint256) private directBetMaxPayout;
    uint256 public lastDirectBetBaseCost;
    uint256 public lastDirectBetMaxPayout;
    address public paymentHandler;

    mapping(uint256 => EntryRecord) public entryHistory;
    mapping(address => uint256[]) public playerEntries;
    
    uint256 public nextEntryId;
    uint8 private directFallbackIdx;   // for directOutcomes remainder
    bool private directFallbackSet;
    // ---- Events ----

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

    event ConsolationPaid(address indexed player, uint256 payout);

    // ---- Errors ----
    error InvalidGame(address game);
    error GameDisabled(address game);
    error InvalidProbabilityTable();
    error InvalidTierConfiguration();
    error ProbabilityOverflow();
    error UnauthorizedCaller();
    error InsufficientFunds();

    // ---- Constructor ----
    constructor(address _evaToken, address _randomProvider) {
        require(_evaToken != address(0), "Invalid token");
        require(_randomProvider != address(0), "Invalid provider");
        evaToken = IERC20(_evaToken);
        randomProvider = IRandomProviderMinimal(_randomProvider);
    }

// ---- Game management ----
    function setGameFallback(address game, uint8 idx) external onlyOwner {
        if (!registeredGames[game]) revert InvalidGame(game);
        GameConfig storage cfg = gameConfigs[game];
        require(idx < cfg.outcomes.length, "idx oob");
        OutcomeConfig storage oc = cfg.outcomes[idx];
        require(!oc.awardsTier && oc.consolationMultiplier == 0, "Not pure lose");
        cfg.fallbackIdx = idx;
        cfg.fallbackSet = true;
    }

    function setDirectFallback(uint8 idx) external onlyOwner {
        require(idx < directOutcomes.length, "idx oob");
        OutcomeConfig storage oc = directOutcomes[idx];
        require(!oc.awardsTier && oc.consolationMultiplier == 0, "Not pure lose");
        directFallbackIdx = idx;
        directFallbackSet = true;
    }
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

    function getGameOutcomes(address game) external view returns (OutcomeConfig[] memory) {
        GameConfig storage cfg = gameConfigs[game];
        uint256 len = cfg.outcomes.length;
        OutcomeConfig[] memory results = new OutcomeConfig[](len);
        for (uint256 i = 0; i < len; i++) {
            results[i] = cfg.outcomes[i];
        }
        return results;
    }

    function getRegisteredGames() external view returns (address[] memory) {
        return gameList;
    }

    function getGameInfo(address game)
        external
        view
        returns (bool enabled, uint16 maxConsolationMultiplier)
    {
        GameConfig storage cfg = gameConfigs[game];
        return (cfg.enabled, cfg.maxConsolationMultiplier);
    }

    function ensurePayable(address game, uint256 betAmount) external view {
        GameConfig storage cfg = gameConfigs[game];
        if (!cfg.enabled) revert GameDisabled(game);

        uint256 balance = _jackpotBalance();

        uint8 tierIndex = jackpotState.nextTierIndex;
        uint256 tierLiability = _tierPrizeLiability(tierIndex);
        require(balance >= tierLiability, "Jackpot underfunded");

        if (cfg.maxConsolationMultiplier > 0 && betAmount > 0) {
            uint256 consolationLiability = Math.mulDiv(betAmount, cfg.maxConsolationMultiplier, 10_000);
            require(balance >= consolationLiability, "Jackpot underfunded");
        }
    }

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

        directBetConfig = DirectBetConfig({
            enabled: enabled
        });

        emit DirectBetConfigured(enabled);
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

    // ---- Tier ladder management ----

    function setTierLadder(TierConfig[] calldata tiers) external onlyOwner {
        if (tiers.length == 0 || tiers.length > MAX_ENTRIES) revert InvalidTierConfiguration();

        delete tierConfigs;
        for (uint256 i = 0; i < tiers.length; i++) {
            TierConfig memory tier = tiers[i];
            if (tier.isPercent && tier.prizeMetric > 10_000) {
                revert InvalidTierConfiguration();
            }
            tierConfigs.push(tier);
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
                isPercent: true,
                fixedBetCost: 0,
                useDynamicCost: true
            });
            return (tierIndex, tier, 0);
        }

        tier = tierConfigs[tierIndex];
        prizeAmount = _computePrizeAmount(tier);
    }

    // ---- Funding ----

    function addFunds(uint256 amount) external nonReentrant {
        if (!registeredGames[msg.sender]) revert UnauthorizedCaller();
        require(amount > 0, "Amount must be positive");

        evaToken.safeTransferFrom(msg.sender, address(this), amount);
        emit FundsAdded(msg.sender, amount, _jackpotBalance());
    }

    function getJackpotBalance() external view returns (uint256) {
        return _jackpotBalance();
    }

    // ---- Core entry processing ----

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
        uint8 outcomeIndex = _resolveOutcome(cfg.outcomes, roll, cfg.fallbackIdx, cfg.fallbackSet);
        OutcomeConfig memory outcome = cfg.outcomes[outcomeIndex];

        // Ensure jackpot can cover worst-case outcome (tier prize or consolation)
        uint256 balance = _jackpotBalance();
        if (outcome.awardsTier) {
            uint256 prizeLiability = _tierPrizeLiability(tierIndex);
            require(balance >= prizeLiability, "Jackpot underfunded");
        } else if (outcome.consolationMultiplier > 0) {
            uint256 consolationLiability = Math.mulDiv(betAmount, outcome.consolationMultiplier, 10_000);
            require(balance >= consolationLiability, "Jackpot underfunded");
        }

        payout = _handleOutcome(player, betAmount, tierIndex, outcome);

        _updateProgression(state, tierIndex, outcome);

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

    function placeDirectBet(address potentialReferrer) external nonReentrant returns (uint256 requestId) {
        address handler = paymentHandler;
        require(handler != address(0), "Handler not set");

        DirectBetConfig memory config = directBetConfig;
        if (!config.enabled) revert("Direct betting disabled");
        require(directOutcomes.length > 0, "Direct outcomes not set");

        uint8 tierIndex = jackpotState.nextTierIndex;
        uint256 cost = _computeTierCost(tierIndex);
        require(cost > 0, "Cost unavailable");

        lastDirectBetBaseCost = cost;

        uint256 netAmount = IPaymentHandler(handler).processDirectBetFromGame(msg.sender, potentialReferrer, cost);
        require(netAmount <= cost, "Handler returned excess");

        uint256 maxPayout = _computeMaxDirectBetPayout(netAmount, tierIndex);
        require(maxPayout > 0, "Max payout unavailable");

        uint256 balance = _jackpotBalance();
        uint256 prizeLiability = _tierPrizeLiability(tierIndex);
        require(balance >= prizeLiability, "Jackpot underfunded");

        requestId = _createDirectBetRequest(msg.sender, netAmount, tierIndex);
        directBetBaseCost[requestId] = cost;
        directBetMaxPayout[requestId] = maxPayout;
        lastDirectBetMaxPayout = maxPayout;
    }
    
    // ---- Internal helpers ----

    function _resolveOutcome(
        OutcomeConfig[] storage outcomes,
        uint256 roll,
        uint8 fbIdx,
        bool fbSet
    ) internal view returns (uint8) {
        uint256 metric = _jackpotBalance();
        uint256 cumulative = 0;

        for (uint8 i = 0; i < outcomes.length; i++) {
            OutcomeConfig storage oc = outcomes[i];
            if (!oc.scaling.enabled) continue;
            uint16 p = JackpotScalingLib.computeProbability(oc.scaling, metric); // bps
            if (p == 0) continue;
            cumulative += p;
            if (roll < cumulative) return i;
        }

        if (fbSet) return fbIdx;
        revert InvalidProbabilityTable(); // no slice hit and no fallback configured
    }

    function _awardTier(
        address player,
        uint8 tierIndex,
        OutcomeConfig memory outcome
    ) internal returns (uint256 payout) {
        if (tierIndex >= tierConfigs.length) revert InvalidTierConfiguration();

        TierConfig memory tier = tierConfigs[tierIndex];
        if (tier.isPercent && tier.prizeMetric > 10_000) {
            revert InvalidTierConfiguration();
        }
        payout = _computePrizeAmount(tier);
        if (payout > _jackpotBalance()) revert InsufficientFunds();
        jackpotState.lastWinner = player;
        jackpotState.lastWinTimestamp = block.timestamp;

        _transferPayout(player, payout);
        emit TierWon(tierIndex, player, payout);

        if (outcome.tierAdvance == 0 || tier.isTerminal) {
            jackpotState.totalJackpotsWon++;
            emit JackpotWon(player, payout);
        }
    }

    function _transferPayout(address player, uint256 amount) internal {
        if (amount == 0) return;
        evaToken.safeTransfer(player, amount);
    }
    
    function _jackpotBalance() internal view returns (uint256) {
        return evaToken.balanceOf(address(this));
    }

    function _computePrizeAmount(TierConfig memory tier) internal view returns (uint256) {
        if (tier.isPercent) {
            if (tier.prizeMetric > 10_000) revert InvalidTierConfiguration();
            uint256 balance = _jackpotBalance();
            uint256 amount = (balance * tier.prizeMetric) / 10_000;
            if (tier.isTerminal) {
                uint256 cap = (balance * 90) / 100;
                if (amount > cap) {
                    amount = cap;
                }
            }
            return amount;
        }
        return tier.prizeMetric;
    }

    function _computeTierCost(uint8 tierIndex) internal view returns (uint256) {
        if (tierConfigs.length == 0) return 0;
        if (tierIndex >= tierConfigs.length) tierIndex = uint8(tierConfigs.length - 1);
        TierConfig memory tier = tierConfigs[tierIndex];
        if (!tier.useDynamicCost) {
            return tier.fixedBetCost;
        }
        return _computePrizeAmount(tier);
    }

    function _computeMaxDirectBetPayout(uint256 netAmount, uint8 tierIndex) internal view returns (uint256) {
        uint256 maxPayout;
        if (tierConfigs.length > 0) {
            if (tierIndex >= tierConfigs.length) {
                tierIndex = uint8(tierConfigs.length - 1);
            }
            uint256 tierPrize = _computePrizeAmount(tierConfigs[tierIndex]);
            if (tierPrize > maxPayout) {
                maxPayout = tierPrize;
            }
        }

        for (uint256 i = 0; i < directOutcomes.length; i++) {
            OutcomeConfig memory outcome = directOutcomes[i];
            if (outcome.awardsTier) {
                continue;
            }
            if (outcome.consolationMultiplier > 0) {
                uint256 consolation = (netAmount * outcome.consolationMultiplier) / 10_000;
                if (consolation > maxPayout) {
                    maxPayout = consolation;
                }
            }
        }

        return maxPayout;
    }

    function _tierPrizeLiability(uint8 tierIndex) internal view returns (uint256) {
        if (tierConfigs.length == 0) {
            return 0;
        }

        uint8 idx = tierIndex;
        if (idx >= tierConfigs.length) {
            idx = uint8(tierConfigs.length - 1);
        }

        return _computePrizeAmount(tierConfigs[idx]);
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

        uint8 outcomeIndex = _resolveOutcome(directOutcomes, roll, directFallbackIdx, directFallbackSet);
        OutcomeConfig memory outcome = directOutcomes[outcomeIndex];

        uint256 payout = _handleOutcome(info.bettor, info.amount, info.tierIndex, outcome);
        uint256 maxPayout = directBetMaxPayout[requestId];
        if (maxPayout == 0) {
            maxPayout = _computeMaxDirectBetPayout(info.amount, info.tierIndex);
        }
        require(payout <= maxPayout, "Payout exceeds max");

        _updateProgression(jackpotState, info.tierIndex, outcome);

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

        // refund bettor
        _transferPayout(info.bettor, info.amount);
        info.settled = true;
        delete directBetRequests[requestId];
        delete directBetBaseCost[requestId];
        delete directBetMaxPayout[requestId];
    }

function _validateOutcomes(OutcomeConfig[] calldata outcomes) internal pure {
    if (outcomes.length == 0) revert InvalidProbabilityTable();
}

    function _handleOutcome(
        address player,
        uint256 betAmount,
        uint8 tierIndex,
        OutcomeConfig memory outcome
    ) internal returns (uint256 payout) {
        JackpotState storage state = jackpotState;

        if (outcome.awardsTier) {
            payout = _awardTier(player, tierIndex, outcome);
        } else if (outcome.consolationMultiplier > 0) {
            payout = (betAmount * outcome.consolationMultiplier) / 10_000;
            _transferPayout(player, payout);
            state.totalConsolationPaid += payout;
            emit ConsolationPaid(player, payout);
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

        if (destination >= tierConfigs.length || tierConfigs[destination].isTerminal) {
            state.nextTierIndex = outcome.tierResetTo;
        } else {
            state.nextTierIndex = destination;
        }
    }

    // ---- View helpers ----

    function getJackpotState() external view returns (JackpotState memory) {
        return jackpotState;
    }
    
    function getPlayerEntries(address player) external view returns (uint256[] memory) {
        return playerEntries[player];
    }

    function getEntry(uint256 entryId) external view returns (EntryRecord memory) {
        return entryHistory[entryId];
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
}


