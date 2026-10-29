// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

/**
 * @title IBlackjackTableGame
 * @notice Types and events of the multi-seat Blackjack table: classic live-casino
 *         tables of up to seven seats, one shared shoe per round, one VRF word per
 *         round, server-seed commit before any bet, every seat's play signed as it
 *         happens, and a full on-chain replay of the table at settlement.
 */
interface IBlackjackTableGame {
    enum RoundStatus {
        None,
        Open,     // betting: seats can be taken
        Locked,   // betting closed, VRF requested, cards being played off-chain
        Settled,
        Refunded
    }

    /// @notice Extra wagers a seat can add during a round.
    enum WagerKind {
        Double,    // +stake, one more card, hand completes
        Split,     // +stake, two hands
        Insurance  // +stake/2, pays 2:1 on a dealer natural (ace up only)
    }

    struct Round {
        uint8 tableId;
        RoundStatus status;
        uint8 seatMask;    // bit i set = seat i taken
        uint8 seatCount;
        uint40 openedAt;
        uint40 lockedAt;
        bytes32 commit;    // keccak256(abi.encodePacked(serverSeed)), published before any bet
        uint256 requestId; // RandomProvider request (set at lock)
        uint256 locked;    // exposure reserved for this round (all seats)
    }

    struct Seat {
        address player;
        uint128 stake;        // gross main wager (payouts are computed on the gross amount)
        uint128 sideBet;      // gross Perfect Pairs wager
        address actionSigner; // optional one-round key that may sign this seat's play
        address sessionKey;   // AuthHub session key at the bet: the only session key that may sign this seat's play
        bool doubled;
        bool split;
        bool insured;
    }

    struct TableConfig {
        bool enabled;
        uint8 tables;          // table ids 0..tables-1
        uint8 seats;           // seats per table (<= 7)
        uint128 minBet;
        uint128 maxBet;
        uint128 maxSideBet;    // 0 = Perfect Pairs disabled
        uint32 settleTimeout;  // seconds after lock when the operator may cancel a round whose VRF never came
        uint32 refundTimeout;  // seconds after open/lock when anyone may refund every seat
    }

    /// @notice One seat's play as submitted at settlement.
    /// @param actions   the whole log (one byte per action)
    /// @param signedLen prefix covered by `signature` (EIP-712 SeatPlay); everything
    ///                  after it may only be STAND / INSURE_NO (timeouts)
    /// @param signature by the player, the session key snapshotted at the bet, or the seat's actionSigner
    struct SeatPlay {
        uint8 seat;
        bytes actions;
        uint16 signedLen;
        bytes signature;
    }

    event TableConfigUpdated(
        bool enabled,
        uint8 tables,
        uint8 seats,
        uint128 minBet,
        uint128 maxBet,
        uint128 maxSideBet,
        uint32 settleTimeout,
        uint32 refundTimeout
    );

    event RoundOpened(uint256 indexed roundId, uint8 indexed tableId, bytes32 commit);

    event SeatTaken(
        uint256 indexed roundId,
        uint8 indexed seat,
        address indexed player,
        uint256 stake,
        uint256 sideBet,
        address actionSigner,
        uint256 locked
    );

    event RoundLocked(uint256 indexed roundId, uint256 requestId, uint8 seatCount);

    event WagerAdded(uint256 indexed roundId, uint8 indexed seat, address indexed player, WagerKind kind, uint256 amount, uint256 locked);

    /// @param outcome ABI-encoded BlackjackTableLib.SeatResult
    event SeatSettled(
        uint256 indexed roundId,
        uint8 indexed seat,
        address indexed player,
        uint256 payout,
        bytes actions,
        uint16 signedLen,
        bytes outcome
    );

    event RoundSettled(
        uint256 indexed roundId,
        uint8 indexed tableId,
        bytes32 serverSeed,
        uint256 vrfWord,
        bytes dealerCards,
        uint256 totalPayout
    );

    event SeatRefunded(uint256 indexed roundId, uint8 indexed seat, address indexed player, uint256 amount);
    event RoundRefunded(uint256 indexed roundId, uint8 indexed tableId, bytes32 reason);
    event HouseFundsWithdrawn(address indexed to, uint256 amount);
    event ConfigManagerSet(address indexed account, bool status);
}
