// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

import {GameLifecycleRoles} from "./base/GameLifecycleRoles.sol";

/// @title TicketLottery
/// @notice On-chain weighted lottery using Chainlink VRF directly.
///   A game operator (allowlisted by the owner) submits a player list with ticket counts and
///   the desired number of winners. VRF provides the randomness; the contract selects N unique
///   winners weighted by tickets.
contract TicketLottery is VRFConsumerBaseV2Plus, GameLifecycleRoles {
    // --- Structs ---

    struct LotteryData {
        address[] players;
        uint256[] tickets;
        uint256 totalTickets;
        uint8 numWinners;
        bool fulfilled;
        uint256 randomWord;
        address[] winners;
    }

    // --- State ---

    bytes32 public immutable keyHash;
    uint256 public immutable subId;
    uint16 public constant REQUEST_CONFIRMATIONS = 3;
    uint32 public constant CALLBACK_GAS_LIMIT = 2_500_000;

    mapping(uint256 => LotteryData) private lotteries;

    // --- Events ---

    event LotteryRequested(
        uint256 indexed requestId,
        uint256 totalTickets,
        uint8 numWinners,
        uint256 playerCount
    );

    event LotteryFulfilled(
        uint256 indexed requestId,
        address[] winners,
        uint256 randomWord
    );

    // --- Errors ---

    error EmptyPlayerList();
    error ArrayLengthMismatch();
    error ZeroTickets(uint256 index);
    error TooManyWinners(uint8 requested, uint256 players);
    error ZeroWinners();
    error LotteryNotFound(uint256 requestId);
    error LotteryNotFulfilled(uint256 requestId);

    // --- Constructor ---

    /// @param vrfCoordinator Chainlink VRF Coordinator address on Arbitrum.
    /// @param _keyHash       VRF key hash (gas lane).
    /// @param _subId         Chainlink VRF subscription ID.
    constructor(
        address vrfCoordinator,
        bytes32 _keyHash,
        uint256 _subId,
        address initialOperator
    ) VRFConsumerBaseV2Plus(vrfCoordinator) {
        keyHash = _keyHash;
        subId = _subId;

        if (initialOperator != address(0)) {
            _setGameOperator(initialOperator, true);
        }
    }

    // --- Core ---

    /// @notice Start a lottery draw.
    /// @param players   Array of participant addresses.
    /// @param tickets   Array of ticket counts (same length as players). Each must be > 0.
    /// @param numWinners How many unique winners to select (must be <= players.length).
    /// @return requestId The Chainlink VRF request ID (also emitted in LotteryRequested).
    function requestWinners(
        address[] calldata players,
        uint256[] calldata tickets,
        uint8 numWinners
    ) external onlyGameOperator returns (uint256 requestId) {
        if (players.length == 0) revert EmptyPlayerList();
        if (players.length != tickets.length) revert ArrayLengthMismatch();
        if (numWinners == 0) revert ZeroWinners();
        if (numWinners > players.length) revert TooManyWinners(numWinners, players.length);

        uint256 totalTickets;
        for (uint256 i = 0; i < tickets.length; i++) {
            if (tickets[i] == 0) revert ZeroTickets(i);
            totalTickets += tickets[i];
        }

        requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subId,
                requestConfirmations: REQUEST_CONFIRMATIONS,
                callbackGasLimit: CALLBACK_GAS_LIMIT,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({nativePayment: false})
                )
            })
        );

        LotteryData storage ld = lotteries[requestId];
        ld.players = players;
        ld.tickets = tickets;
        ld.totalTickets = totalTickets;
        ld.numWinners = numWinners;

        emit LotteryRequested(requestId, totalTickets, numWinners, players.length);
    }

    /// @dev Chainlink VRF callback. Selects N unique winners via weighted sampling.
    function fulfillRandomWords(
        uint256 requestId,
        uint256[] calldata randomWords
    ) internal override {
        LotteryData storage ld = lotteries[requestId];
        if (ld.players.length == 0) revert LotteryNotFound(requestId);

        uint256 randomWord = randomWords[0];
        ld.randomWord = randomWord;
        ld.fulfilled = true;

        uint256 playerCount = ld.players.length;
        uint8 n = ld.numWinners;

        // Working copies for weighted sampling without replacement
        uint256[] memory pool = new uint256[](playerCount);
        for (uint256 i = 0; i < playerCount; i++) {
            pool[i] = ld.tickets[i];
        }
        uint256 remaining = ld.totalTickets;

        address[] memory winners = new address[](n);

        for (uint8 w = 0; w < n; w++) {
            uint256 rand = uint256(keccak256(abi.encodePacked(randomWord, w)));
            uint256 pick = rand % remaining;

            uint256 cumulative;
            for (uint256 j = 0; j < playerCount; j++) {
                if (pool[j] == 0) continue;
                cumulative += pool[j];
                if (pick < cumulative) {
                    winners[w] = ld.players[j];
                    remaining -= pool[j];
                    pool[j] = 0;
                    break;
                }
            }
        }

        ld.winners = winners;

        emit LotteryFulfilled(requestId, winners, randomWord);
    }

    // --- Views ---

    /// @notice Get the full result of a completed lottery.
    /// @return winners      The selected winner addresses.
    /// @return randomWord   The VRF random word used.
    /// @return players      Original player list.
    /// @return tickets      Original ticket counts.
    /// @return totalTickets  Sum of all tickets.
    function getLotteryResult(uint256 requestId)
        external
        view
        returns (
            address[] memory winners,
            uint256 randomWord,
            address[] memory players,
            uint256[] memory tickets,
            uint256 totalTickets
        )
    {
        LotteryData storage ld = lotteries[requestId];
        if (ld.players.length == 0) revert LotteryNotFound(requestId);
        if (!ld.fulfilled) revert LotteryNotFulfilled(requestId);
        return (ld.winners, ld.randomWord, ld.players, ld.tickets, ld.totalTickets);
    }

    /// @notice Check if a lottery has been fulfilled.
    function isLotteryFulfilled(uint256 requestId) external view returns (bool) {
        return lotteries[requestId].fulfilled;
    }

    // --- Operator allowlist ---

    function setGameOperator(address operator, bool status) external onlyOwner {
        _setGameOperator(operator, status);
    }

    function setGameOperators(address[] calldata operators, bool status) external onlyOwner {
        for (uint256 i = 0; i < operators.length; i++) {
            _setGameOperator(operators[i], status);
        }
    }
}
