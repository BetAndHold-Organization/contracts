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

    event LevelsUpdated(uint8 levelCount, uint16[MAX_LEVELS] levelBps);
    event DefaultReceiverSet(address indexed receiver);
    event PaymentHandlerSet(address indexed handler);
    event ReferrerRecorded(address indexed player, address indexed referrer);
    event RewardsWithdrawn(address indexed referrer, uint256 amount);

    constructor(address evaToken_, address defaultReceiver_) {
        require(evaToken_ != address(0), "Invalid token");
        evaToken = IERC20(evaToken_);
        defaultReceiver = defaultReceiver_;
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
        defaultReceiver = receiver;
        emit DefaultReceiverSet(receiver);
    }

    function setPaymentHandler(address handler) external onlyOwner {
        paymentHandler = handler;
        emit PaymentHandlerSet(handler);
    }

    function recordReferral(address player, address potentialReferrer, uint256 referralAmount) external nonReentrant {
        require(msg.sender == paymentHandler, "Only handler");
        LevelsConfig memory cfg = levelsConfig;
        if (cfg.levelCount == 0 || referralAmount == 0) {
            return;
        }

        _maybeAssignReferrer(player, potentialReferrer);

        address current = referrerOf[player];
        if (current == address(0)) {
            _assignFallback(referralAmount);
            emit ReferrerRecorded(player, address(0));
            return;
        }

        address[MAX_LEVELS] memory chain;
        uint16[MAX_LEVELS] memory bpsUsed;
        uint8 usedLevels;
        uint32 totalBps;

        for (uint8 level = 0; level < cfg.levelCount && current != address(0); level++) {
            uint16 levelBps = cfg.levelBps[level];
            if (levelBps == 0) {
                current = referrerOf[current];
                continue;
            }

            chain[usedLevels] = current;
            bpsUsed[usedLevels] = levelBps;
            totalBps += levelBps;
            usedLevels++;
            current = referrerOf[current];
        }

        if (usedLevels == 0 || totalBps == 0) {
            if (!_assignFallback(referralAmount)) {
                emit ReferrerRecorded(player, address(0));
            }
            return;
        }

        uint256 remainingAmount = referralAmount;
        for (uint8 i = 0; i < usedLevels; i++) {
            uint256 share;
            if (i == usedLevels - 1) {
                share = remainingAmount;
            } else {
                share = (referralAmount * bpsUsed[i]) / totalBps;
                if (share > remainingAmount) {
                    share = remainingAmount;
                }
                remainingAmount -= share;
            }

            if (share == 0) {
                continue;
            }

            address recipient = chain[i];
            pendingRewards[recipient] += share;
        }
    }

    function withdrawRewards() external nonReentrant {
        uint256 amount = pendingRewards[msg.sender];
        require(amount > 0, "No rewards");
        pendingRewards[msg.sender] = 0;
        evaToken.safeTransfer(msg.sender, amount);
        emit RewardsWithdrawn(msg.sender, amount);
    }

    function _maybeAssignReferrer(address player, address potentialReferrer) private {
        if (player == address(0) || potentialReferrer == address(0)) {
            return;
        }
        if (referrerOf[player] != address(0)) {
            return;
        }
        require(potentialReferrer != player, "Cannot refer self");
        referrerOf[player] = potentialReferrer;
        emit ReferrerRecorded(player, potentialReferrer);
    }

    function _assignFallback(uint256 amount) private returns (bool) {
        if (amount == 0) return false;
        address receiver = defaultReceiver;
        if (receiver == address(0)) {
            receiver = owner();
        }
        if (receiver != address(0)) {
            pendingRewards[receiver] += amount;
            return true;
        }
        return false;
    }

    function getLevels() external view returns (uint8 levelCount, uint16[MAX_LEVELS] memory levelBps) {
        LevelsConfig memory cfg = levelsConfig;
        return (cfg.levelCount, cfg.levelBps);
    }

    function getReferrer(address player) external view returns (address) {
        return referrerOf[player];
    }
}

