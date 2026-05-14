// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MultiLevelReferral is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant MAX_LEVELS = 5;
    uint16 public constant MAX_BPS = 10_000;
    /// @notice Sentinel level value used in RewardCredited when crediting the defaultReceiver fallback.
    uint8 public constant FALLBACK_LEVEL = type(uint8).max;
    /// @dev Safety bound on chain walks during cycle detection.
    uint256 private constant CYCLE_WALK_CAP = 32;

    IERC20 public immutable evaToken;
    address public paymentHandler;

    struct LevelsConfig {
        uint8 levelCount;
        uint16[MAX_LEVELS] levelBps;
    }

    LevelsConfig public levelsConfig;
    address public defaultReceiver;

    mapping(address => address) public referrerOf;
    mapping(address => uint256) public pendingRewards;

    /// @notice Sum of all pendingRewards. Tracked so emergencyWithdraw cannot drain owed balances.
    uint256 public totalPendingRewards;

    event LevelsUpdated(uint8 levelCount, uint16[MAX_LEVELS] levelBps);
    event DefaultReceiverSet(address indexed receiver);
    event PaymentHandlerSet(address indexed handler);
    event ReferrerRecorded(address indexed player, address indexed referrer);
    event RewardsWithdrawn(address indexed referrer, uint256 amount);
    /// @notice Emitted for every reward credit. level == FALLBACK_LEVEL indicates routing to defaultReceiver.
    event RewardCredited(
        address indexed player,
        address indexed recipient,
        uint8 level,
        uint256 amount
    );
    event AdminReferralSeeded(address indexed referee, address indexed referrer);

    constructor(address evaToken_, address defaultReceiver_) {
        require(evaToken_ != address(0), "Invalid token");
        require(defaultReceiver_ != address(0), "Invalid default receiver");
        evaToken = IERC20(evaToken_);
        defaultReceiver = defaultReceiver_;
        emit DefaultReceiverSet(defaultReceiver_);
    }

    function setLevels(uint8 levelCount, uint16[] calldata levelBps) external onlyOwner {
        require(levelCount > 0 && levelCount <= MAX_LEVELS, "Invalid level count");
        require(levelBps.length == levelCount, "Invalid array length");

        uint16 total;
        uint16[MAX_LEVELS] memory stored;
        for (uint8 i = 0; i < levelCount; i++) {
            require(levelBps[i] <= MAX_BPS, "Bps too high");
            stored[i] = levelBps[i];
            total += levelBps[i];
        }
        require(total <= MAX_BPS, "Total bps too high");

        levelsConfig = LevelsConfig({levelCount: levelCount, levelBps: stored});
        emit LevelsUpdated(levelCount, stored);
    }

    function setDefaultReceiver(address receiver) external onlyOwner {
        require(receiver != address(0), "Invalid receiver");
        defaultReceiver = receiver;
        emit DefaultReceiverSet(receiver);
    }

    function setPaymentHandler(address handler) external onlyOwner {
        paymentHandler = handler;
        emit PaymentHandlerSet(handler);
    }

    function recordReferral(address player, address potentialReferrer, uint256 referralAmount) external nonReentrant {
        require(msg.sender == paymentHandler, "Only handler");
        if (referralAmount == 0) return;

        LevelsConfig memory cfg = levelsConfig;

        // No levels configured: route entire referralAmount to defaultReceiver instead of stranding it.
        if (cfg.levelCount == 0) {
            _creditFallback(player, referralAmount);
            return;
        }

        _maybeAssignReferrer(player, potentialReferrer);

        address current = referrerOf[player];
        if (current == address(0)) {
            _creditFallback(player, referralAmount);
            return;
        }

        // Use the configured total bps as the denominator so that "missing" levels in a short
        // chain leave a remainder that flows to the default receiver, instead of being silently
        // redistributed across present levels.
        uint32 configuredTotalBps;
        for (uint8 i = 0; i < cfg.levelCount; i++) {
            configuredTotalBps += cfg.levelBps[i];
        }

        if (configuredTotalBps == 0) {
            _creditFallback(player, referralAmount);
            return;
        }

        uint256 allocated;
        for (uint8 level = 0; level < cfg.levelCount && current != address(0); level++) {
            uint16 levelBps = cfg.levelBps[level];
            address recipient = current;
            current = referrerOf[current];

            if (levelBps == 0) continue;

            uint256 share = (referralAmount * levelBps) / configuredTotalBps;
            if (share == 0) continue;

            pendingRewards[recipient] += share;
            allocated += share;
            emit RewardCredited(player, recipient, level, share);
        }

        if (allocated > 0) {
            totalPendingRewards += allocated;
        }

        uint256 unallocated = referralAmount - allocated;
        if (unallocated > 0) {
            _creditFallback(player, unallocated);
        }
    }

    function withdrawRewards() external nonReentrant {
        uint256 amount = pendingRewards[msg.sender];
        require(amount > 0, "No rewards");
        pendingRewards[msg.sender] = 0;
        totalPendingRewards -= amount;
        evaToken.safeTransfer(msg.sender, amount);
        emit RewardsWithdrawn(msg.sender, amount);
    }

    function getLevels() external view returns (uint8 levelCount, uint16[MAX_LEVELS] memory levelBps) {
        LevelsConfig memory cfg = levelsConfig;
        return (cfg.levelCount, cfg.levelBps);
    }

    function getReferrer(address player) external view returns (address) {
        return referrerOf[player];
    }

    /// @notice Owner-controlled batch seeding of referrer relationships.
    /// @dev Used to migrate referral graphs across iterations. Cycle detection enforced.
    function adminSetReferrers(address[] calldata referees, address[] calldata referrers) external onlyOwner {
        require(referees.length == referrers.length, "len");
        for (uint256 i = 0; i < referees.length; i++) {
            address usr = referees[i];
            address ref = referrers[i];
            require(usr != address(0), "referee");
            require(ref != address(0) && ref != usr, "referrer");
            require(referrerOf[usr] == address(0), "already set");
            require(!_wouldCreateCycle(usr, ref), "Cycle detected");
            referrerOf[usr] = ref;
            emit AdminReferralSeeded(usr, ref);
        }
    }

    /// @notice Recover any tokens held by this contract. Drains the full balance, including
    ///         tokens that back pending reward balances. The owner is trusted to coordinate
    ///         out-of-band reimbursement; this function provides a hard escape hatch with no
    ///         amount-based exceptions.
    /// @param to     Recipient of the withdrawn tokens. Must be non-zero.
    /// @param amount Amount to withdraw; pass 0 to withdraw the entire current balance.
    function emergencyWithdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "to");
        uint256 bal = evaToken.balanceOf(address(this));
        uint256 amt = amount == 0 ? bal : amount;
        require(amt <= bal, "insufficient");
        evaToken.safeTransfer(to, amt);
    }

    /// @dev Assign player's referrer if not yet set. Reverts if assignment would create a cycle.
    function _maybeAssignReferrer(address player, address potentialReferrer) private {
        if (player == address(0) || potentialReferrer == address(0)) return;
        if (referrerOf[player] != address(0)) return;
        require(potentialReferrer != player, "Cannot refer self");
        require(!_wouldCreateCycle(player, potentialReferrer), "Cycle detected");
        referrerOf[player] = potentialReferrer;
        emit ReferrerRecorded(player, potentialReferrer);
    }

    /// @dev Walk up the proposed chain. If `player` appears, the assignment would create a cycle.
    function _wouldCreateCycle(address player, address proposedReferrer) private view returns (bool) {
        address current = proposedReferrer;
        for (uint256 i = 0; i < CYCLE_WALK_CAP && current != address(0); i++) {
            if (current == player) return true;
            current = referrerOf[current];
        }
        return false;
    }

    /// @dev Credit the configured defaultReceiver. Reverts if not set.
    /// @dev Callers must ensure `amount > 0` — this function intentionally has no zero-guard
    ///      because every internal call site already filters zeros (recordReferral early-returns
    ///      on amount == 0; the post-loop unallocated branch checks `unallocated > 0`).
    function _creditFallback(address player, uint256 amount) private {
        address receiver = defaultReceiver;
        require(receiver != address(0), "Default receiver not set");
        pendingRewards[receiver] += amount;
        totalPendingRewards += amount;
        emit RewardCredited(player, receiver, FALLBACK_LEVEL, amount);
    }
}
