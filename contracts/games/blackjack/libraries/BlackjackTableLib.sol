// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

/**
 * @title BlackjackTableLib
 * @notice Pure, deterministic replay of one blackjack TABLE round: up to seven
 *         seats against one dealer, dealt from one shared shoe in casino order.
 *         Mirrors the TypeScript engine (`blackjackBackend/src/engine/deterministic/table.ts`)
 *         step for step; both are pinned by the same golden vectors.
 *
 *         Rules v1 (per hand, identical to the single-seat game): 6 decks shuffled
 *         per round, blackjack pays 3:2 (initial two cards only), dealer hits soft
 *         17, double only on a two-card hard 9-11, no double after split, split once
 *         on equal value, split aces receive one card, 21 after a split pays 1:1, no
 *         surrender, dealer peeks (ace up: after insurance; ten up: silently),
 *         insurance pays 2:1, Perfect Pairs pays 25/12/6.
 *
 *         Table order:
 *           deal  — first card to every seat (lowest seat first), dealer up,
 *                   second card to every seat, dealer hole;
 *           ace up — every seat's FIRST action is its insurance answer;
 *           peek  — a dealer natural ends the round;
 *           play  — seat by seat, lowest first; a seat with a natural is done;
 *           dealer — draws only if some seat still has a live hand that is neither
 *                   busted nor a natural.
 *
 *         Cards are 0..51: rank = card % 13 (0 = ace … 9..12 = ten-valued),
 *         suit = card / 13 (0 spades, 1 hearts, 2 diamonds, 3 clubs).
 *         Shoe: 312 slots initialised to `i % 52`; draw i performs one step of a
 *         Fisher-Yates driven by `s = keccak256(abi.encodePacked(s, uint16(i)))`,
 *         `j = i + uint256(s) % (312 - i)`.
 *
 *         `play` is EXTERNAL: the library is deployed once and linked, which keeps
 *         BlackjackTableGame under the 24 KB contract-size limit.
 */
library BlackjackTableLib {
    uint8 internal constant RULES_VERSION = 1;
    uint8 internal constant MAX_SEATS = 7;
    uint16 internal constant SHOE_SIZE = 312;
    uint8 internal constant MAX_HANDS = 2;

    // Actions (one byte each)
    uint8 internal constant HIT = 0;
    uint8 internal constant STAND = 1;
    uint8 internal constant DOUBLE = 2;
    uint8 internal constant SPLIT = 3;
    uint8 internal constant INSURE_YES = 4;
    uint8 internal constant INSURE_NO = 5;

    // Hand outcomes
    uint8 internal constant OUT_BLACKJACK = 0;
    uint8 internal constant OUT_WIN = 1;
    uint8 internal constant OUT_PUSH = 2;
    uint8 internal constant OUT_LOSE = 3;
    uint8 internal constant OUT_BUST = 4;

    // Perfect Pairs outcomes
    uint8 internal constant PP_NONE = 0;
    uint8 internal constant PP_MIXED = 1;
    uint8 internal constant PP_COLORED = 2;
    uint8 internal constant PP_PERFECT = 3;

    error BadSeats();
    error IllegalAction(uint8 seat, uint256 index, uint8 action);
    error IncompleteActions(uint8 seat);
    error TrailingActions(uint8 seat);
    /// @dev An action that costs money (double / split / insurance) was played without its on-chain wager.
    error UnfundedAction(uint8 seat, uint8 action);
    error ShoeExhausted();

    /// @notice One occupied seat: what was wagered on-chain.
    struct SeatInput {
        uint8 seat;      // 0..6, strictly ascending across the array
        uint256 stake;   // gross main wager
        uint256 sideBet; // gross Perfect Pairs wager
        bool doubled;    // on-chain extra wagers: an action needs its flag (else UnfundedAction);
        bool split;      // a flag whose action was never played is refunded (wagerRefund)
        bool insured;
    }

    struct SeatResult {
        uint8 seat;
        uint256 payout;          // stakes returned + winnings + wagerRefund
        uint256 wagerRefund;
        uint256 insurancePayout;
        uint256 sideBetPayout;
        uint8 sideBetOutcome;    // PP_*
        bool natural;
        uint8 handCount;
        uint8[2] handOutcomes;   // OUT_*
        uint256[2] handPayouts;
        bytes hand0Cards;
        bytes hand1Cards;
    }

    struct Result {
        SeatResult[] seats;
        bytes dealerCards;
        bool dealerNatural;
        uint256 totalPayout;
        uint16 cardsDrawn;
    }

    struct Shoe {
        uint16[312] slots;
        bytes32 state;
        uint16 index;
    }

    struct Hand {
        uint8[12] cards;
        uint8 count;
        uint256 bet;
        bool fromSplit;
        bool doubled;
        bool done;
        bool bust;
    }

    struct Seat {
        Hand[2] hands;
        uint8 handCount;
        uint8 active;
        bool natural;
        bool insuranceTaken;
        bool anyDoubled;
        bool split;
        bool done;
        uint256 cursor; // next action to read from this seat's log
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              CARDS
    // ═══════════════════════════════════════════════════════════════════════

    function isAce(uint8 card) internal pure returns (bool) {
        return card % 13 == 0;
    }

    function isRed(uint8 card) internal pure returns (bool) {
        uint8 s = card / 13;
        return s == 1 || s == 2;
    }

    /// @dev Ace counts 1 here; ten and faces count 10.
    function valueOf(uint8 card) internal pure returns (uint8) {
        uint8 r = card % 13;
        if (r == 0) return 1;
        if (r >= 9) return 10;
        return r + 1;
    }

    function handValue(uint8[12] memory cards, uint8 count) internal pure returns (uint8 hard, uint8 total, bool soft) {
        uint8 aces = 0;
        for (uint8 i = 0; i < count; i++) {
            hard += valueOf(cards[i]);
            if (isAce(cards[i])) aces++;
        }
        soft = aces > 0 && hard + 10 <= 21;
        total = soft ? hard + 10 : hard;
    }

    function twoCardValue(uint8 a, uint8 b) internal pure returns (uint8) {
        uint8 hard = valueOf(a) + valueOf(b);
        bool soft = (isAce(a) || isAce(b)) && hard + 10 <= 21;
        return soft ? hard + 10 : hard;
    }

    function perfectPairs(uint8 a, uint8 b) internal pure returns (uint8) {
        if (a % 13 != b % 13) return PP_NONE;
        if (a / 13 == b / 13) return PP_PERFECT;
        if (isRed(a) == isRed(b)) return PP_COLORED;
        return PP_MIXED;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              SHOE
    // ═══════════════════════════════════════════════════════════════════════

    function newShoe(bytes32 seed) internal pure returns (Shoe memory shoe) {
        for (uint16 i = 0; i < SHOE_SIZE; i++) {
            shoe.slots[i] = i % 52;
        }
        shoe.state = seed;
    }

    function draw(Shoe memory shoe) internal pure returns (uint8 card) {
        uint16 i = shoe.index;
        if (i >= SHOE_SIZE) revert ShoeExhausted();
        shoe.state = keccak256(abi.encodePacked(shoe.state, i));
        uint256 j = uint256(i) + (uint256(shoe.state) % uint256(SHOE_SIZE - i));
        uint16 tmp = shoe.slots[i];
        shoe.slots[i] = shoe.slots[j];
        shoe.slots[j] = tmp;
        shoe.index = i + 1;
        return uint8(shoe.slots[i]);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //                              REPLAY
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * @notice Replay a table round from its seed and every seat's action log.
     * @param inputs  occupied seats, strictly ascending by seat index
     * @param actions one log per input, same order; each must finish its seat exactly
     * @dev   Reverts on bad seats, an illegal action, a log that ends early or has
     *        trailing actions, and an action played without its on-chain wager.
     */
    function play(
        bytes32 seed,
        SeatInput[] memory inputs,
        bytes[] memory actions
    ) external pure returns (Result memory res) {
        uint256 n = inputs.length;
        if (n == 0 || n > MAX_SEATS || actions.length != n) revert BadSeats();
        for (uint256 i = 0; i < n; i++) {
            if (inputs[i].seat >= MAX_SEATS || (i > 0 && inputs[i].seat <= inputs[i - 1].seat)) revert BadSeats();
        }

        Shoe memory shoe = newShoe(seed);
        Seat[] memory seats = new Seat[](n);
        for (uint256 i = 0; i < n; i++) seats[i].hands[0].cards[0] = draw(shoe);
        uint8 up = draw(shoe);
        for (uint256 i = 0; i < n; i++) seats[i].hands[0].cards[1] = draw(shoe);
        uint8 hole = draw(shoe);

        res.seats = new SeatResult[](n);
        for (uint256 i = 0; i < n; i++) {
            Seat memory s = seats[i];
            Hand memory h = s.hands[0];
            h.count = 2;
            h.bet = inputs[i].stake;
            s.handCount = 1;
            s.natural = twoCardValue(h.cards[0], h.cards[1]) == 21;
            res.seats[i].sideBetOutcome = perfectPairs(h.cards[0], h.cards[1]);
        }
        res.dealerNatural = twoCardValue(up, hole) == 21;

        // Insurance: every seat answers first (no card is drawn, so order is irrelevant).
        if (isAce(up)) {
            for (uint256 i = 0; i < n; i++) {
                uint8 a = _next(seats[i], actions[i], inputs[i].seat);
                if (a != INSURE_YES && a != INSURE_NO) revert IllegalAction(inputs[i].seat, seats[i].cursor - 1, a);
                seats[i].insuranceTaken = a == INSURE_YES;
            }
        }

        // Peek, then the seats play in order.
        for (uint256 i = 0; i < n; i++) {
            if (res.dealerNatural || seats[i].natural) {
                seats[i].done = true;
                seats[i].hands[0].done = true;
            }
        }
        for (uint256 i = 0; i < n; i++) {
            Seat memory s = seats[i];
            while (!s.done) {
                uint256 index = s.cursor;
                uint8 a = _next(s, actions[i], inputs[i].seat);
                _apply(s, shoe, a, inputs[i], index);
            }
            if (s.cursor != actions[i].length) revert TrailingActions(inputs[i].seat);
            if (s.anyDoubled && !inputs[i].doubled) revert UnfundedAction(inputs[i].seat, DOUBLE);
            if (s.split && !inputs[i].split) revert UnfundedAction(inputs[i].seat, SPLIT);
            if (s.insuranceTaken && !inputs[i].insured) revert UnfundedAction(inputs[i].seat, INSURE_YES);
        }

        _dealerAndPay(seats, shoe, up, hole, inputs, res);
        res.cardsDrawn = shoe.index;
    }

    function _next(Seat memory s, bytes memory log, uint8 seat) private pure returns (uint8 a) {
        if (s.cursor >= log.length) revert IncompleteActions(seat);
        a = uint8(log[s.cursor]);
        s.cursor++;
    }

    function _canDouble(Hand memory h) private pure returns (bool) {
        if (h.count != 2 || h.fromSplit) return false;
        uint8 hard = valueOf(h.cards[0]) + valueOf(h.cards[1]);
        return hard >= 9 && hard <= 11;
    }

    function _canSplit(Seat memory s, Hand memory h) private pure returns (bool) {
        if (h.count != 2 || s.handCount >= MAX_HANDS) return false;
        return valueOf(h.cards[0]) == valueOf(h.cards[1]);
    }

    function _apply(Seat memory s, Shoe memory shoe, uint8 a, SeatInput memory input, uint256 index) private pure {
        Hand memory h = s.hands[s.active];
        if (a == HIT) {
            h.cards[h.count++] = draw(shoe);
            (uint8 hard, uint8 total, ) = handValue(h.cards, h.count);
            if (hard > 21) {
                h.bust = true;
                h.done = true;
            } else if (total == 21) {
                h.done = true;
            }
            if (h.done) _advance(s, shoe);
        } else if (a == STAND) {
            h.done = true;
            _advance(s, shoe);
        } else if (a == DOUBLE) {
            if (!_canDouble(h)) revert IllegalAction(input.seat, index, a);
            h.bet = h.bet * 2;
            h.doubled = true;
            s.anyDoubled = true;
            // Only legal on a hard 9-11, so one more card can never bust.
            h.cards[h.count++] = draw(shoe);
            h.done = true;
            _advance(s, shoe);
        } else if (a == SPLIT) {
            if (!_canSplit(s, h)) revert IllegalAction(input.seat, index, a);
            uint8 c1 = h.cards[1];
            s.split = true;
            h.count = 1;
            h.cards[1] = 0;
            h.fromSplit = true;
            Hand memory h1 = s.hands[1];
            h1.cards[0] = c1;
            h1.count = 1;
            h1.bet = input.stake;
            h1.fromSplit = true;
            s.handCount = 2;
            _advance(s, shoe);
        } else {
            revert IllegalAction(input.seat, index, a);
        }
    }

    /// @dev Next open hand of the seat — always a fresh split half waiting for its second card — or the seat is done.
    function _advance(Seat memory s, Shoe memory shoe) private pure {
        for (;;) {
            while (s.active < s.handCount && s.hands[s.active].done) s.active++;
            if (s.active >= s.handCount) {
                s.done = true;
                return;
            }
            Hand memory h = s.hands[s.active];
            h.cards[h.count++] = draw(shoe);
            if (isAce(h.cards[0])) {
                h.done = true; // split aces receive exactly one card
                continue;
            }
            (, uint8 total, ) = handValue(h.cards, h.count);
            if (total == 21) {
                h.done = true;
                continue;
            }
            return;
        }
    }

    function _dealerAndPay(
        Seat[] memory seats,
        Shoe memory shoe,
        uint8 up,
        uint8 hole,
        SeatInput[] memory inputs,
        Result memory res
    ) private pure {
        uint8[12] memory dealer;
        uint8 dcount = 2;
        dealer[0] = up;
        dealer[1] = hole;

        bool anyLive = false;
        for (uint256 i = 0; i < seats.length && !anyLive; i++) {
            if (seats[i].natural) continue;
            for (uint8 k = 0; k < seats[i].handCount; k++) {
                if (!seats[i].hands[k].bust) anyLive = true;
            }
        }
        if (!res.dealerNatural && anyLive) {
            for (;;) {
                (, uint8 total, bool soft) = handValue(dealer, dcount);
                if (total > 17) break;
                if (total == 17 && !soft) break; // H17: hits soft 17
                dealer[dcount++] = draw(shoe);
            }
        }
        (uint8 dHard, uint8 dTotal, ) = handValue(dealer, dcount);
        res.dealerCards = _cardsBytes(dealer, dcount);

        for (uint256 i = 0; i < seats.length; i++) {
            res.seats[i] = _paySeat(seats[i], inputs[i], res.seats[i].sideBetOutcome, res.dealerNatural, dHard > 21, dTotal);
            res.totalPayout += res.seats[i].payout;
        }
    }

    function _paySeat(
        Seat memory s,
        SeatInput memory input,
        uint8 pp,
        bool dealerNatural,
        bool dealerBust,
        uint8 dTotal
    ) private pure returns (SeatResult memory r) {
        r.seat = input.seat;
        r.sideBetOutcome = pp;
        r.natural = s.natural;
        r.handCount = s.handCount;
        uint256 payout = 0;
        for (uint8 k = 0; k < s.handCount; k++) {
            Hand memory h = s.hands[k];
            (, uint8 total, ) = handValue(h.cards, h.count);
            uint8 outcome;
            uint256 hp;
            if (dealerNatural) {
                outcome = s.natural ? OUT_PUSH : OUT_LOSE;
                hp = s.natural ? h.bet : 0;
            } else if (s.natural) {
                outcome = OUT_BLACKJACK;
                hp = h.bet + (h.bet * 3) / 2;
            } else if (h.bust) {
                outcome = OUT_BUST;
                hp = 0;
            } else if (dealerBust || total > dTotal) {
                outcome = OUT_WIN;
                hp = h.bet * 2;
            } else if (total == dTotal) {
                outcome = OUT_PUSH;
                hp = h.bet;
            } else {
                outcome = OUT_LOSE;
                hp = 0;
            }
            r.handOutcomes[k] = outcome;
            r.handPayouts[k] = hp;
            payout += hp;
        }
        r.hand0Cards = _cardsBytes(s.hands[0].cards, s.hands[0].count);
        if (s.handCount > 1) r.hand1Cards = _cardsBytes(s.hands[1].cards, s.hands[1].count);

        if (s.insuranceTaken && dealerNatural) {
            // Insurance is exactly stake/2 (what addWager collected, floored); paying 3x that amount is intended.
            // slither-disable-next-line divide-before-multiply
            r.insurancePayout = (input.stake / 2) * 3;
            payout += r.insurancePayout;
        }
        if (input.sideBet > 0 && pp != PP_NONE) {
            uint256 mult = pp == PP_PERFECT ? 26 : (pp == PP_COLORED ? 13 : 7);
            r.sideBetPayout = input.sideBet * mult;
            payout += r.sideBetPayout;
        }

        // Extra wagers collected on-chain that the play never consumed go back to the player.
        uint256 refund = 0;
        if (input.doubled && !s.anyDoubled) refund += input.stake;
        if (input.split && !s.split) refund += input.stake;
        if (input.insured && !s.insuranceTaken) refund += input.stake / 2;
        r.wagerRefund = refund;
        r.payout = payout + refund;
    }

    function _cardsBytes(uint8[12] memory cards, uint8 count) private pure returns (bytes memory out) {
        out = new bytes(count);
        for (uint8 i = 0; i < count; i++) out[i] = bytes1(cards[i]);
    }
}
