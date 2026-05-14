// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMultiLevelReferral {
    function recordReferral(address player, address potentialReferrer, uint256 referralAmount) external;
    function getReferrer(address player) external view returns (address);
}

interface IProgressiveJackpot {
    function addFunds(uint256 amount) external;
}

/**
 * @title PaymentHandler
 * @notice Inflow router for all bets. Slices each bet into:
 *           - house edge fee  (→ feeRecipient)
 *           - referral fee    (→ MultiLevelReferral)
 *           - jackpot share   (→ ProgressiveJackpot, via addFunds)
 *           - net stake       (→ game's bankroll)
 *         Prize resolution and payouts remain direct between game and player / jackpot.
 *
 * @dev    The platform-wide ProgressiveJackpot is registered once via setJackpot. To avoid a
 *         re-entrancy collision when the jackpot itself uses placeDirectBet, register the
 *         jackpot in this contract with `jackpotBps = 0`.
 */
contract PaymentHandler is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_BPS = 10_000;

    IERC20 public immutable evaToken;
    address public referralContract;
    IProgressiveJackpot public jackpot;

    struct GameConfig {
        bool exists;
        bool enabled;
        address payoutTarget;
        address feeRecipient;
        uint16 houseEdgeBps;
        uint16 referralBps;
        uint16 jackpotBps;
    }

    mapping(address => GameConfig) private gameConfigs;

    /// Whitelist and blacklist for initial test scenario
    bool public whitelistEnabled;
    bool public blacklistEnabled;
    mapping(address => bool) public whitelist;
    mapping(address => bool) public blacklist;
    mapping(address => bool) public selfExcluded;

    event WhitelistStatusChanged(bool enabled);
    event BlacklistStatusChanged(bool enabled);
    event WhitelistUpdated(address indexed account, bool value);
    event BlacklistUpdated(address indexed account, bool value);
    event SelfExcluded(address indexed account);
    event GameRegistered(
        address indexed game,
        address payoutTarget,
        address feeRecipient,
        uint16 houseEdgeBps,
        uint16 referralBps,
        uint16 jackpotBps
    );
    event GameUpdated(
        address indexed game,
        address payoutTarget,
        address feeRecipient,
        uint16 houseEdgeBps,
        uint16 referralBps,
        uint16 jackpotBps
    );
    event GameBetProcessed(
        address indexed game,
        address indexed bettor,
        address indexed assignedReferrer,
        uint256 baseCost,
        uint256 houseFee,
        uint256 referralFee,
        uint256 jackpotShare,
        uint256 netAmount
    );
    event GameStatusChanged(address indexed game, bool enabled);
    event ReferralContractSet(address indexed referralContract);
    event JackpotSet(address indexed jackpot);

    constructor(address evaToken_) {
        require(evaToken_ != address(0), "Invalid EVA token");
        evaToken = IERC20(evaToken_);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              ADMIN
    // ═══════════════════════════════════════════════════════════════════════

    function setReferralContract(address referralContract_) external onlyOwner {
        referralContract = referralContract_;
        emit ReferralContractSet(referralContract_);
    }

    /// @notice Set or replace the platform-wide jackpot. Approves the new jackpot for max EVA so it
    ///         can pull contributions via addFunds. Revokes the old jackpot's approval first.
    function setJackpot(address newJackpot) external onlyOwner {
        address old = address(jackpot);
        if (old != address(0)) {
            evaToken.safeApprove(old, 0);
        }
        jackpot = IProgressiveJackpot(newJackpot);
        if (newJackpot != address(0)) {
            evaToken.safeApprove(newJackpot, type(uint256).max);
        }
        emit JackpotSet(newJackpot);
    }

    function setWhitelistEnabled(bool enabled) external onlyOwner {
        whitelistEnabled = enabled;
        emit WhitelistStatusChanged(enabled);
    }

    function setBlacklistEnabled(bool enabled) external onlyOwner {
        blacklistEnabled = enabled;
        emit BlacklistStatusChanged(enabled);
    }

    function setWhitelist(address[] calldata addrs, bool value) external onlyOwner {
        for (uint256 i = 0; i < addrs.length; i++) {
            whitelist[addrs[i]] = value;
            emit WhitelistUpdated(addrs[i], value);
        }
    }

    function setBlacklist(address[] calldata addrs, bool value) external onlyOwner {
        for (uint256 i = 0; i < addrs.length; i++) {
            blacklist[addrs[i]] = value;
            emit BlacklistUpdated(addrs[i], value);
        }
    }

    function registerGame(
        address game,
        address payoutTarget,
        address feeRecipient,
        uint16 houseEdgeBps,
        uint16 referralBps,
        uint16 jackpotBps
    ) external onlyOwner {
        require(game != address(0), "Invalid game");
        require(payoutTarget != address(0), "Invalid payout target");
        require(uint256(houseEdgeBps) + uint256(referralBps) + uint256(jackpotBps) <= MAX_BPS, "Bps overflow");

        GameConfig storage cfg = gameConfigs[game];
        require(!cfg.exists, "Game already registered");

        cfg.exists = true;
        cfg.enabled = true;
        cfg.payoutTarget = payoutTarget;
        cfg.feeRecipient = feeRecipient;
        cfg.houseEdgeBps = houseEdgeBps;
        cfg.referralBps = referralBps;
        cfg.jackpotBps = jackpotBps;

        emit GameRegistered(game, payoutTarget, feeRecipient, houseEdgeBps, referralBps, jackpotBps);
        emit GameStatusChanged(game, true);
    }

    function updateGameConfig(
        address game,
        address payoutTarget,
        address feeRecipient,
        uint16 houseEdgeBps,
        uint16 referralBps,
        uint16 jackpotBps
    ) external onlyOwner {
        require(payoutTarget != address(0), "Invalid payout target");
        require(uint256(houseEdgeBps) + uint256(referralBps) + uint256(jackpotBps) <= MAX_BPS, "Bps overflow");

        GameConfig storage cfg = gameConfigs[game];
        require(cfg.exists, "Game not registered");

        cfg.payoutTarget = payoutTarget;
        cfg.feeRecipient = feeRecipient;
        cfg.houseEdgeBps = houseEdgeBps;
        cfg.referralBps = referralBps;
        cfg.jackpotBps = jackpotBps;

        emit GameUpdated(game, payoutTarget, feeRecipient, houseEdgeBps, referralBps, jackpotBps);
    }

    function setGameStatus(address game, bool enabled) external onlyOwner {
        GameConfig storage cfg = gameConfigs[game];
        require(cfg.exists, "Game not registered");
        cfg.enabled = enabled;
        emit GameStatusChanged(game, enabled);
    }

    /// @notice Permanently self-exclude from all games. Irreversible.
    function selfExclude() external {
        require(!selfExcluded[msg.sender], "Already excluded");
        selfExcluded[msg.sender] = true;
        emit SelfExcluded(msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              VIEW
    // ═══════════════════════════════════════════════════════════════════════

    function getGameConfig(address game)
        external
        view
        returns (
            bool enabled,
            address payoutTarget,
            address feeRecipient,
            uint16 houseEdgeBps,
            uint16 referralBps,
            uint16 jackpotBps
        )
    {
        GameConfig memory cfg = gameConfigs[game];
        return (cfg.enabled, cfg.payoutTarget, cfg.feeRecipient, cfg.houseEdgeBps, cfg.referralBps, cfg.jackpotBps);
    }

    /// @notice Address of the platform-wide jackpot.
    function getJackpot() external view returns (address) {
        return address(jackpot);
    }

    /// @notice Sum of houseEdgeBps + referralBps + jackpotBps for the given game.
    function getTotalDeductionBps(address game) external view returns (uint16) {
        GameConfig memory cfg = gameConfigs[game];
        return cfg.houseEdgeBps + cfg.referralBps + cfg.jackpotBps;
    }

    /// @notice Fraction (in bps) of the bet that reaches the game's bankroll.
    function getNetStakeBps(address game) external view returns (uint16) {
        GameConfig memory cfg = gameConfigs[game];
        return MAX_BPS - cfg.houseEdgeBps - cfg.referralBps - cfg.jackpotBps;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              CORE: BET INFLOW
    // ═══════════════════════════════════════════════════════════════════════

    function _checkAccess(address player) internal view {
        if (selfExcluded[player]) revert("Self-excluded");
        if (blacklistEnabled && blacklist[player]) revert("Blacklisted");
        if (whitelistEnabled && !whitelist[player]) revert("Not whitelisted");
    }

    /// @notice Slice a bet into its component flows. Inflow only — no payouts or resolution.
    function processDirectBetFromGame(address bettor, address potentialReferrer, uint256 baseCost)
        external
        nonReentrant
        returns (uint256 netAmount)
    {
        _checkAccess(bettor);
        GameConfig memory cfg = gameConfigs[msg.sender];
        require(cfg.exists, "Game not registered");
        require(cfg.enabled, "Game disabled");
        require(baseCost > 0, "Amount must be positive");

        uint256 houseFee = (baseCost * cfg.houseEdgeBps) / MAX_BPS;
        uint256 referralFee = (baseCost * cfg.referralBps) / MAX_BPS;
        uint256 jackpotShare = (baseCost * cfg.jackpotBps) / MAX_BPS;
        netAmount = baseCost - houseFee - referralFee - jackpotShare;
        require(netAmount > 0, "Net amount zero");

        // Pull bet from game, then route slices
        evaToken.safeTransferFrom(msg.sender, address(this), baseCost);

        if (houseFee > 0) {
            require(cfg.feeRecipient != address(0), "Fee recipient not set");
            evaToken.safeTransfer(cfg.feeRecipient, houseFee);
        }

        address referral = referralContract;
        if (referralFee > 0) {
            require(referral != address(0), "Referral contract not set");
            evaToken.safeTransfer(referral, referralFee);
            IMultiLevelReferral(referral).recordReferral(bettor, potentialReferrer, referralFee);
        }

        if (jackpotShare > 0) {
            address jp = address(jackpot);
            require(jp != address(0), "Jackpot not set");
            // Jackpot pulls jackpotShare from this contract via the standing approval set in setJackpot.
            jackpot.addFunds(jackpotShare);
        }

        evaToken.safeTransfer(cfg.payoutTarget, netAmount);

        address assignedReferrer = referral == address(0)
            ? address(0)
            : IMultiLevelReferral(referral).getReferrer(bettor);
        emit GameBetProcessed(
            msg.sender,
            bettor,
            assignedReferrer,
            baseCost,
            houseFee,
            referralFee,
            jackpotShare,
            netAmount
        );
    }
}
