// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "hardhat/console.sol";

interface IMultiLevelReferral {
    function recordReferral(address player, address potentialReferrer, uint256 referralAmount) external;
}

contract PaymentHandler is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_BPS = 10_000;

    IERC20 public immutable evaToken;
    address public referralContract;

    struct GameConfig {
        bool exists;
        bool enabled;
        address payoutTarget;
        address feeRecipient;
        uint16 houseEdgeBps;
        uint16 referralBps;
    }

    mapping(address => GameConfig) private gameConfigs;

    event GameRegistered(
        address indexed game,
        address payoutTarget,
        address feeRecipient,
        uint16 houseEdgeBps,
        uint16 referralBps
    );
    event GameUpdated(
        address indexed game,
        address payoutTarget,
        address feeRecipient,
        uint16 houseEdgeBps,
        uint16 referralBps
    );
    event GameStatusChanged(address indexed game, bool enabled);
    event ReferralContractSet(address indexed referralContract);

    constructor(address evaToken_) {
        require(evaToken_ != address(0), "Invalid EVA token");
        evaToken = IERC20(evaToken_);
    }

    function setReferralContract(address referralContract_) external onlyOwner {
        referralContract = referralContract_;
        emit ReferralContractSet(referralContract_);
    }

    function registerGame(
        address game,
        address payoutTarget,
        address feeRecipient,
        uint16 houseEdgeBps,
        uint16 referralBps
    ) external onlyOwner {
        require(game != address(0), "Invalid game");
        require(payoutTarget != address(0), "Invalid payout target");
        require(houseEdgeBps + referralBps <= MAX_BPS, "Bps overflow");

        GameConfig storage cfg = gameConfigs[game];
        require(!cfg.exists, "Game already registered");

        cfg.exists = true;
        cfg.enabled = true;
        cfg.payoutTarget = payoutTarget;
        cfg.feeRecipient = feeRecipient;
        cfg.houseEdgeBps = houseEdgeBps;
        cfg.referralBps = referralBps;

        emit GameRegistered(game, payoutTarget, feeRecipient, houseEdgeBps, referralBps);
        emit GameStatusChanged(game, true);
    }

    function updateGameConfig(
        address game,
        address payoutTarget,
        address feeRecipient,
        uint16 houseEdgeBps,
        uint16 referralBps
    ) external onlyOwner {
        require(houseEdgeBps + referralBps <= MAX_BPS, "Bps overflow");

        GameConfig storage cfg = gameConfigs[game];
        require(cfg.exists, "Game not registered");

        cfg.payoutTarget = payoutTarget;
        cfg.feeRecipient = feeRecipient;
        cfg.houseEdgeBps = houseEdgeBps;
        cfg.referralBps = referralBps;

        emit GameUpdated(game, payoutTarget, feeRecipient, houseEdgeBps, referralBps);
    }

    function setGameStatus(address game, bool enabled) external onlyOwner {
        GameConfig storage cfg = gameConfigs[game];
        require(cfg.exists, "Game not registered");
        cfg.enabled = enabled;
        emit GameStatusChanged(game, enabled);
    }

    function getGameConfig(address game)
        external
        view
        returns (
            bool enabled,
            address payoutTarget,
            address feeRecipient,
            uint16 houseEdgeBps,
            uint16 referralBps
        )
    {
        GameConfig memory cfg = gameConfigs[game];
        return (cfg.enabled, cfg.payoutTarget, cfg.feeRecipient, cfg.houseEdgeBps, cfg.referralBps);
    }

    function processDirectBetFromGame(address bettor, address potentialReferrer, uint256 baseCost)
        external
        nonReentrant
        returns (uint256 netAmount)
    {
        GameConfig memory cfg = gameConfigs[msg.sender];
        require(cfg.exists, "Game not registered");
        require(cfg.enabled, "Game disabled");
        require(baseCost > 0, "Amount must be positive");

        uint256 houseFee;
        if (cfg.houseEdgeBps > 0) {
            require(cfg.houseEdgeBps <= MAX_BPS, "House edge too high");
            require(cfg.feeRecipient != address(0), "Fee recipient not set");
            houseFee = (baseCost * cfg.houseEdgeBps) / MAX_BPS;
        }

        uint256 referralFee;
        if (cfg.referralBps > 0) {
            require(cfg.referralBps <= MAX_BPS, "Referral bps too high");
            referralFee = (baseCost * cfg.referralBps) / MAX_BPS;
        }

        netAmount = baseCost - houseFee - referralFee;
        require(netAmount > 0, "Net amount zero");

        evaToken.safeTransferFrom(bettor, address(this), baseCost);

        if (houseFee > 0) {
            evaToken.safeTransfer(cfg.feeRecipient, houseFee);
        }

        if (referralFee > 0) {
            address referral = referralContract;
            require(referral != address(0), "Referral contract not set");
            evaToken.safeTransfer(referral, referralFee);
            IMultiLevelReferral(referral).recordReferral(bettor, potentialReferrer, referralFee);
        }

        evaToken.safeTransfer(cfg.payoutTarget, netAmount);
    }
}

