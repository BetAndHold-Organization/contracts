// VENDORED COPY — source of truth: blackjackBackend/src/engine/deterministic/table.ts.
// Kept identical by the shared golden vectors (test/fixtures/blackjack-golden-table-rounds.json).
import { handValue, isAce, isTwentyOneOnTwo, valueOf, type Card, type HandValue } from "./cards.js";
import { Action, type ActionCode } from "./actions.js";
import { RULES, blackjackPayout, insuranceAmount } from "./rules.js";
import type { Shoe } from "./shoe.js";
import { evalPerfectPairs, type HandOutcome, type HandState, type SideBetOutcome, type WagerFlags } from "./blackjack.js";

/**
 * A blackjack TABLE round: up to seven seats against one dealer, dealt from one
 * shared shoe in casino order. Mirrors `BlackjackTableLib.sol` step for step;
 * both are pinned by the same golden vectors.
 *
 *   Deal: first card to every seat (lowest seat first = first base), dealer up,
 *         second card to every seat, dealer hole.
 *   Ace up: every seat decides insurance (simultaneously, order irrelevant: no
 *         card is drawn), then the dealer peeks. Ten up: silent peek.
 *         A dealer natural ends the round.
 *   Play: seat by seat, lowest first. A seat with a natural is done at once.
 *         Each seat plays its hands exactly like the single-seat engine: hands
 *         auto-complete at 21 and on bust; after a split hand 0 gets its second
 *         card at once, hand 1 when its turn comes; split aces get one card.
 *   Dealer: draws (H17) only if some seat still has a live hand that is neither
 *         busted nor a natural.
 *
 * Every seat's action log is its own; the seats' logs together decide which
 * cards everybody gets (a hit at seat 1 changes seat 2's next card), exactly
 * like a real table.
 */

export interface SeatInput {
  /** Seat index 0..6 (0 = first base, dealt first). */
  seat: number;
  /** Gross main wager (wei). */
  stake: bigint;
  /** Gross Perfect Pairs wager (wei). */
  sideBet: bigint;
}

export type TablePhase = "insurance" | "playing" | "finished";

export interface SeatState {
  seat: number;
  input: SeatInput;
  hands: HandState[];
  actions: ActionCode[];
  activeHand: number;
  natural: boolean;
  sideBetOutcome: SideBetOutcome;
  /** null until the seat answers the insurance question (ace up only). */
  insuranceTaken: boolean | null;
  split: boolean;
  done: boolean;
}

export interface SeatHandResult {
  cards: Card[];
  value: HandValue;
  bet: bigint;
  outcome: HandOutcome;
  payout: bigint;
}

export interface SeatResult {
  seat: number;
  /** Total the contract pays this seat (stakes returned + winnings + wagerRefund). */
  payout: bigint;
  wagerRefund: bigint;
  hands: SeatHandResult[];
  natural: boolean;
  insuranceTaken: boolean;
  insurancePayout: bigint;
  sideBetOutcome: SideBetOutcome;
  sideBetPayout: bigint;
}

export interface TableResult {
  seats: SeatResult[];
  dealerCards: Card[];
  dealerValue: HandValue;
  dealerNatural: boolean;
  cardsDrawn: number;
}

/** What everybody at the table may see mid-round (the hole card stays hidden). */
export interface TableView {
  phase: TablePhase;
  /** Seat whose turn it is (playing phase), else null. */
  turnSeat: number | null;
  dealerUp: Card;
  dealerCards: Card[] | null;
  insuranceOffered: boolean;
  seats: Array<{
    seat: number;
    hands: Array<{ cards: Card[]; value: HandValue; bet: bigint; fromSplit: boolean; doubled: boolean; done: boolean; bust: boolean }>;
    activeHand: number;
    natural: boolean;
    sideBetOutcome: SideBetOutcome;
    insuranceTaken: boolean | null;
    split: boolean;
    done: boolean;
    actions: ActionCode[];
    legalActions: ActionCode[];
  }>;
}

export class TableIllegalActionError extends Error {
  constructor(
    public readonly seat: number,
    public readonly action: ActionCode,
    public readonly legal: readonly ActionCode[],
    public readonly phase: TablePhase,
  ) {
    super(`seat ${seat}: illegal action ${action} in phase ${phase} (legal: ${legal.join(",")})`);
    this.name = "TableIllegalActionError";
  }
}

export class TableIncompleteError extends Error {
  constructor(public readonly phase: TablePhase) {
    super(`table round not finished (phase ${phase})`);
    this.name = "TableIncompleteError";
  }
}

export const MAX_SEATS = 7;

export class TableRun {
  readonly seats: SeatState[];
  readonly dealerUp: Card;
  readonly dealerNatural: boolean;
  readonly insuranceOffered: boolean;
  phase: TablePhase;
  /** Index into `seats` of the seat whose turn it is (playing phase). */
  turn = 0;
  private readonly dealerHole: Card;
  private dealerCards: Card[] | null = null;
  private result: TableResult | null = null;

  constructor(
    private readonly shoe: Shoe,
    inputs: readonly SeatInput[],
  ) {
    if (inputs.length === 0 || inputs.length > MAX_SEATS) throw new RangeError("a table round needs 1..7 seats");
    const sorted = [...inputs].sort((a, b) => a.seat - b.seat);
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i]!;
      if (!Number.isInteger(s.seat) || s.seat < 0 || s.seat >= MAX_SEATS) throw new RangeError(`invalid seat ${s.seat}`);
      if (i > 0 && sorted[i - 1]!.seat === s.seat) throw new RangeError(`seat ${s.seat} twice`);
      if (s.stake <= 0n || s.sideBet < 0n) throw new RangeError("invalid seat input");
    }
    const first = sorted.map(() => shoe.draw());
    const up = shoe.draw();
    const second = sorted.map(() => shoe.draw());
    const hole = shoe.draw();
    this.dealerUp = up;
    this.dealerHole = hole;
    this.dealerNatural = isTwentyOneOnTwo([up, hole]);
    this.insuranceOffered = isAce(up);
    this.seats = sorted.map((input, i) => {
      const cards = [first[i]!, second[i]!];
      return {
        seat: input.seat,
        input,
        hands: [{ cards, bet: input.stake, fromSplit: false, doubled: false, done: false, bust: false }],
        actions: [],
        activeHand: 0,
        natural: isTwentyOneOnTwo(cards),
        sideBetOutcome: evalPerfectPairs(cards[0]!, cards[1]!),
        insuranceTaken: null,
        split: false,
        done: false,
      };
    });
    if (this.insuranceOffered) {
      this.phase = "insurance";
    } else {
      this.phase = "playing";
      this.afterPeek();
    }
  }

  seatState(seat: number): SeatState {
    const s = this.seats.find((x) => x.seat === seat);
    if (!s) throw new RangeError(`seat ${seat} is not in this round`);
    return s;
  }

  /** Seat whose turn it is, or null outside the playing phase. */
  get turnSeat(): number | null {
    return this.phase === "playing" ? this.seats[this.turn]!.seat : null;
  }

  /** Dealer peek + naturals, then hand the turn to the first seat that has to play. */
  private afterPeek(): void {
    if (this.dealerNatural) {
      for (const s of this.seats) {
        s.done = true;
        s.hands[0]!.done = true;
      }
      this.phase = "finished";
      return;
    }
    for (const s of this.seats) {
      if (s.natural) {
        s.done = true;
        s.hands[0]!.done = true;
      }
    }
    this.phase = "playing";
    this.turn = 0;
    this.nextTurn();
  }

  /** Skip seats that are done; finish the round after the last one. */
  private nextTurn(): void {
    while (this.turn < this.seats.length && this.seats[this.turn]!.done) this.turn++;
    if (this.turn >= this.seats.length) this.phase = "finished";
  }

  private canDouble(hand: HandState): boolean {
    if (hand.cards.length !== 2) return false;
    if (hand.fromSplit && !RULES.doubleAfterSplit) return false;
    const hard = handValue(hand.cards).hard;
    return hard >= RULES.doubleHardMin && hard <= RULES.doubleHardMax;
  }

  private canSplit(s: SeatState, hand: HandState): boolean {
    if (hand.cards.length !== 2 || s.hands.length >= RULES.maxHands) return false;
    return valueOf(hand.cards[0]!) === valueOf(hand.cards[1]!);
  }

  legalActions(seat: number): ActionCode[] {
    const s = this.seatState(seat);
    if (this.phase === "insurance") return s.insuranceTaken === null ? [Action.INSURE_YES, Action.INSURE_NO] : [];
    if (this.phase !== "playing" || this.seats[this.turn] !== s) return [];
    const hand = s.hands[s.activeHand]!;
    const out: ActionCode[] = [Action.HIT, Action.STAND];
    if (this.canDouble(hand)) out.push(Action.DOUBLE);
    if (this.canSplit(s, hand)) out.push(Action.SPLIT);
    return out;
  }

  apply(seat: number, action: ActionCode): void {
    const s = this.seatState(seat);
    const legal = this.legalActions(seat);
    if (!legal.includes(action)) throw new TableIllegalActionError(seat, action, legal, this.phase);
    s.actions.push(action);
    switch (action) {
      case Action.INSURE_YES:
      case Action.INSURE_NO:
        s.insuranceTaken = action === Action.INSURE_YES;
        if (this.seats.every((x) => x.insuranceTaken !== null)) this.afterPeek();
        return;
      case Action.HIT: {
        const hand = s.hands[s.activeHand]!;
        hand.cards.push(this.shoe.draw());
        const v = handValue(hand.cards);
        if (v.hard > 21) {
          hand.bust = true;
          hand.done = true;
        } else if (v.total === 21) {
          hand.done = true;
        }
        if (hand.done) this.advanceHand(s);
        return;
      }
      case Action.STAND:
        s.hands[s.activeHand]!.done = true;
        this.advanceHand(s);
        return;
      case Action.DOUBLE: {
        const hand = s.hands[s.activeHand]!;
        hand.bet = hand.bet * 2n;
        hand.doubled = true;
        // Only legal on a hard 9-11: one more card can never bust.
        hand.cards.push(this.shoe.draw());
        hand.done = true;
        this.advanceHand(s);
        return;
      }
      case Action.SPLIT: {
        const hand = s.hands[s.activeHand]!;
        const [c0, c1] = hand.cards as [Card, Card];
        s.split = true;
        hand.cards = [c0];
        hand.fromSplit = true;
        s.hands.splice(s.activeHand + 1, 0, { cards: [c1], bet: s.input.stake, fromSplit: true, doubled: false, done: false, bust: false });
        this.advanceHand(s);
        return;
      }
    }
  }

  /** Next unfinished hand of the seat (dealing a split hand its second card), or the next seat. */
  private advanceHand(s: SeatState): void {
    for (;;) {
      while (s.activeHand < s.hands.length && s.hands[s.activeHand]!.done) s.activeHand++;
      if (s.activeHand >= s.hands.length) {
        s.done = true;
        this.nextTurn();
        return;
      }
      // The next open hand is always a fresh split half waiting for its second card.
      const hand = s.hands[s.activeHand]!;
      hand.cards.push(this.shoe.draw());
      if (isAce(hand.cards[0]!)) {
        // Split aces receive exactly one card (RULES.splitAcesOneCard).
        hand.done = true;
        continue;
      }
      if (handValue(hand.cards).total === 21) {
        hand.done = true;
        continue;
      }
      return;
    }
  }

  /** Plays the dealer (if needed) and computes every seat's payout. Idempotent. */
  finish(): TableResult {
    if (this.phase !== "finished") throw new TableIncompleteError(this.phase);
    if (this.result) return this.result;

    const dealerCards: Card[] = [this.dealerUp, this.dealerHole];
    const anyLive = this.seats.some((s) => !s.natural && s.hands.some((h) => !h.bust));
    if (!this.dealerNatural && anyLive) {
      for (;;) {
        const v = handValue(dealerCards);
        if (v.total > 17) break;
        if (v.total === 17 && !(v.soft && RULES.dealerHitsSoft17)) break;
        dealerCards.push(this.shoe.draw());
      }
    }
    this.dealerCards = dealerCards;
    const dealerValue = handValue(dealerCards);
    const dealerBust = dealerValue.hard > 21;

    const seats: SeatResult[] = this.seats.map((s) => {
      let payout = 0n;
      const hands: SeatHandResult[] = s.hands.map((h) => {
        const value = handValue(h.cards);
        let outcome: HandOutcome;
        let hp: bigint;
        if (this.dealerNatural) {
          outcome = s.natural ? "push" : "lose";
          hp = s.natural ? h.bet : 0n;
        } else if (s.natural) {
          outcome = "blackjack";
          hp = blackjackPayout(h.bet);
        } else if (h.bust) {
          outcome = "bust";
          hp = 0n;
        } else if (dealerBust || value.total > dealerValue.total) {
          outcome = "win";
          hp = h.bet * 2n;
        } else if (value.total === dealerValue.total) {
          outcome = "push";
          hp = h.bet;
        } else {
          outcome = "lose";
          hp = 0n;
        }
        payout += hp;
        return { cards: [...h.cards], value, bet: h.bet, outcome, payout: hp };
      });
      const insuranceTaken = s.insuranceTaken === true;
      const insurancePayout = insuranceTaken && this.dealerNatural ? insuranceAmount(s.input.stake) * BigInt(RULES.insurancePays + 1) : 0n;
      payout += insurancePayout;
      const sideBetPayout =
        s.input.sideBet > 0n && s.sideBetOutcome !== "none" ? s.input.sideBet * BigInt(RULES.perfectPairs[s.sideBetOutcome] + 1) : 0n;
      payout += sideBetPayout;
      return {
        seat: s.seat,
        payout,
        wagerRefund: 0n,
        hands,
        natural: s.natural,
        insuranceTaken,
        insurancePayout,
        sideBetOutcome: s.sideBetOutcome,
        sideBetPayout,
      };
    });

    this.result = { seats, dealerCards, dealerValue, dealerNatural: this.dealerNatural, cardsDrawn: this.shoe.drawn };
    return this.result;
  }

  view(): TableView {
    return {
      phase: this.phase,
      turnSeat: this.turnSeat,
      dealerUp: this.dealerUp,
      dealerCards: this.dealerCards ? [...this.dealerCards] : null,
      insuranceOffered: this.insuranceOffered,
      seats: this.seats.map((s) => ({
        seat: s.seat,
        hands: s.hands.map((h) => ({
          cards: [...h.cards],
          value: handValue(h.cards),
          bet: h.bet,
          fromSplit: h.fromSplit,
          doubled: h.doubled,
          done: h.done,
          bust: h.bust,
        })),
        activeHand: s.activeHand,
        natural: s.natural,
        sideBetOutcome: s.sideBetOutcome,
        insuranceTaken: s.insuranceTaken,
        split: s.split,
        done: s.done,
        actions: [...s.actions],
        legalActions: this.legalActions(s.seat),
      })),
    };
  }
}

/** Auto actions the operator may append without the player's signature (timeouts). */
export function isAutoAction(a: ActionCode): boolean {
  return a === Action.STAND || a === Action.INSURE_NO;
}

export class TableUnfundedActionError extends Error {
  constructor(
    public readonly seat: number,
    public readonly action: ActionCode,
  ) {
    super(`seat ${seat}: action ${action} was played without its on-chain wager`);
    this.name = "TableUnfundedActionError";
  }
}

export class TableReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableReplayError";
  }
}

/**
 * Full replay from a shoe and every seat's action log — what the contract and
 * the browser verifier do. Insurance answers are each seat's first action (ace
 * up only); then the seats play in order, each consuming its own log. Every log
 * must finish its seat exactly (auto actions are explicit STAND / INSURE_NO).
 * With `flags`, the on-chain extra wagers are reconciled per seat: an action
 * that costs money without its wager is fatal; an unused wager is refunded.
 */
export function replayTable(
  shoe: Shoe,
  inputs: readonly SeatInput[],
  actionsBySeat: ReadonlyMap<number, readonly ActionCode[]>,
  flagsBySeat?: ReadonlyMap<number, WagerFlags>,
): TableResult {
  const run = new TableRun(shoe, inputs);
  const cursor = new Map<number, number>();
  const next = (seat: number): ActionCode => {
    const log = actionsBySeat.get(seat) ?? [];
    const i = cursor.get(seat) ?? 0;
    if (i >= log.length) throw new TableReplayError(`seat ${seat}: action log ends before the seat finished`);
    cursor.set(seat, i + 1);
    return log[i]!;
  };
  if (run.phase === "insurance") {
    for (const s of run.seats) run.apply(s.seat, next(s.seat));
  }
  while (run.phase === "playing") {
    const seat = run.turnSeat!;
    run.apply(seat, next(seat));
  }
  for (const s of run.seats) {
    const log = actionsBySeat.get(s.seat) ?? [];
    if ((cursor.get(s.seat) ?? 0) !== log.length) throw new TableReplayError(`seat ${s.seat}: trailing actions`);
  }
  for (const seat of actionsBySeat.keys()) {
    if (!run.seats.some((s) => s.seat === seat)) throw new TableReplayError(`seat ${seat} is not in this round`);
  }
  const result = run.finish();
  if (!flagsBySeat) return result;
  return {
    ...result,
    seats: result.seats.map((r) => {
      const s = run.seatState(r.seat);
      const flags = flagsBySeat.get(r.seat) ?? { doubled: false, split: false, insured: false };
      const played = {
        doubled: s.hands.some((h) => h.doubled),
        split: s.split,
        insured: s.insuranceTaken === true,
      };
      if (played.doubled && !flags.doubled) throw new TableUnfundedActionError(r.seat, Action.DOUBLE);
      if (played.split && !flags.split) throw new TableUnfundedActionError(r.seat, Action.SPLIT);
      if (played.insured && !flags.insured) throw new TableUnfundedActionError(r.seat, Action.INSURE_YES);
      let refund = 0n;
      if (flags.doubled && !played.doubled) refund += s.input.stake;
      if (flags.split && !played.split) refund += s.input.stake;
      if (flags.insured && !played.insured) refund += insuranceAmount(s.input.stake);
      return { ...r, wagerRefund: refund, payout: r.payout + refund };
    }),
  };
}

/**
 * Seat-play commitment the player signs after every action (EIP-712
 * `SeatPlay`): the hash of the seat's action log so far. The operator can only
 * append auto actions (STAND / INSURE_NO) after the last signed prefix.
 */
export function splitSignedLog(actions: readonly ActionCode[], signedLen: number): { signed: ActionCode[]; auto: ActionCode[] } {
  if (signedLen < 0 || signedLen > actions.length) throw new RangeError("signedLen out of range");
  const auto = actions.slice(signedLen);
  if (!auto.every(isAutoAction)) throw new TableReplayError("only STAND / INSURE_NO may follow the signed prefix");
  return { signed: actions.slice(0, signedLen), auto };
}
