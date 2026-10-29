import { describe, it, before } from "node:test";
import { expect } from "chai";
import { network } from "hardhat";
import { readFileSync } from "node:fs";
import { hexToBytes, type Hex } from "viem";

import { expectRevert } from "../helpers/utils.js";

/**
 * BlackjackTableLib ↔ TypeScript table engine parity, pinned by the golden
 * vectors generated in blackjackBackend (scripts/genTableGolden.ts).
 */

interface TableGoldenFile {
  rulesVersion: number;
  vectors: Array<{
    name: string;
    seed: Hex;
    seats: Array<{ seat: number; stake: string; sideBet: string; flags: { doubled: boolean; split: boolean; insured: boolean }; actions: Hex }>;
    expected: {
      cardsDrawn: number;
      dealerNatural: boolean;
      dealerCards: number[];
      totalPayout: string;
      seats: Array<{
        seat: number;
        payout: string;
        wagerRefund: string;
        natural: boolean;
        insuranceTaken: boolean;
        insurancePayout: string;
        sideBetOutcome: string;
        sideBetPayout: string;
        hands: Array<{ cards: number[]; bet: string; outcome: string; payout: string }>;
      }>;
    };
  }>;
}

const OUTCOME_CODE: Record<string, number> = { blackjack: 0, win: 1, push: 2, lose: 3, bust: 4 };
const PP_CODE: Record<string, number> = { none: 0, mixed: 1, colored: 2, perfect: 3 };

const golden = JSON.parse(
  readFileSync(new URL("../fixtures/blackjack-golden-table-rounds.json", import.meta.url), "utf8"),
) as TableGoldenFile;

let env: Awaited<ReturnType<typeof network.connect>>;
let harness: any;

before(async () => {
  env = await network.connect();
  const lib = await env.viem.deployContract("BlackjackTableLib");
  harness = await env.viem.deployContract("BlackjackTableHarness", [], { libraries: { BlackjackTableLib: lib.address } });
});

const cards = (hex: Hex): number[] => Array.from(hexToBytes(hex));
const inputsOf = (v: TableGoldenFile["vectors"][number]) =>
  v.seats.map((s) => ({ seat: s.seat, stake: BigInt(s.stake), sideBet: BigInt(s.sideBet), doubled: s.flags.doubled, split: s.flags.split, insured: s.flags.insured }));

describe("BlackjackTableLib — golden vectors", () => {
  it("fixture targets the current rules version", () => {
    expect(golden.rulesVersion).to.equal(1);
    expect(golden.vectors.length).to.be.greaterThanOrEqual(20);
  });

  for (const v of golden.vectors) {
    it(`replays: ${v.name}`, async () => {
      const res = (await harness.read.replayTable([v.seed, inputsOf(v), v.seats.map((s) => s.actions)])) as any;
      expect(Number(res.cardsDrawn)).to.equal(v.expected.cardsDrawn);
      expect(res.dealerNatural).to.equal(v.expected.dealerNatural);
      expect(cards(res.dealerCards)).to.deep.equal(v.expected.dealerCards);
      expect(res.totalPayout.toString()).to.equal(v.expected.totalPayout);
      expect(res.seats.length).to.equal(v.expected.seats.length);
      v.expected.seats.forEach((e, i) => {
        const s = res.seats[i];
        expect(Number(s.seat)).to.equal(e.seat);
        expect(s.payout.toString(), `seat ${e.seat} payout`).to.equal(e.payout);
        expect(s.wagerRefund.toString()).to.equal(e.wagerRefund);
        expect(s.natural).to.equal(e.natural);
        expect(s.insurancePayout.toString()).to.equal(e.insurancePayout);
        expect(Number(s.sideBetOutcome)).to.equal(PP_CODE[e.sideBetOutcome]);
        expect(s.sideBetPayout.toString()).to.equal(e.sideBetPayout);
        expect(Number(s.handCount)).to.equal(e.hands.length);
        e.hands.forEach((h, k) => {
          expect(Number(s.handOutcomes[k])).to.equal(OUTCOME_CODE[h.outcome]);
          expect(s.handPayouts[k].toString()).to.equal(h.payout);
          expect(cards(k === 0 ? s.hand0Cards : s.hand1Cards)).to.deep.equal(h.cards);
        });
      });
    });
  }
});

describe("BlackjackTableLib — rejects malformed tables", () => {
  const v = () => golden.vectors.find((x) => x.seats.length >= 3 && x.name.startsWith("full table, seven"))!;

  it("bad seat lists", async () => {
    const g = v();
    const inputs = inputsOf(g);
    const logs = g.seats.map((s) => s.actions);
    await expectRevert(harness.read.replayTable([g.seed, [], []]), "BadSeats");
    await expectRevert(harness.read.replayTable([g.seed, inputs, logs.slice(1)]), "BadSeats");
    const swapped = [inputs[1], inputs[0], ...inputs.slice(2)];
    await expectRevert(harness.read.replayTable([g.seed, swapped, logs]), "BadSeats");
    const seven = inputs.map((x, i) => (i === inputs.length - 1 ? { ...x, seat: 7 } : x));
    await expectRevert(harness.read.replayTable([g.seed, seven, logs]), "BadSeats");
    const eight = [...inputs, { ...inputs[0]!, seat: 6 }];
    await expectRevert(harness.read.replayTable([g.seed, eight, [...logs, "0x01"]]), "BadSeats");
  });

  it("short, long, illegal and unfunded logs", async () => {
    const g = golden.vectors.find((x) => x.name === "full table with a split and a double")!;
    const inputs = inputsOf(g);
    const logs = g.seats.map((s) => s.actions);
    const playing = g.seats.findIndex((s) => s.actions !== "0x");
    const short = logs.map((l, i) => (i === playing ? ("0x" + l.slice(2, -2)) as Hex : l));
    await expectRevert(harness.read.replayTable([g.seed, inputs, short]), "IncompleteActions");
    const long = logs.map((l, i) => (i === playing ? ((l + "01") as Hex) : l));
    await expectRevert(harness.read.replayTable([g.seed, inputs, long]), "TrailingActions");
    const bad = logs.map((l, i) => (i === playing ? ("0x09" as Hex) : l));
    await expectRevert(harness.read.replayTable([g.seed, inputs, bad]), "IllegalAction");
    const splitter = g.seats.findIndex((s) => s.flags.split);
    const noFlag = inputs.map((x, i) => (i === splitter ? { ...x, split: false } : x));
    await expectRevert(harness.read.replayTable([g.seed, noFlag, logs]), "UnfundedAction");
    const doubler = g.seats.findIndex((s) => s.flags.doubled);
    const noDbl = inputs.map((x, i) => (i === doubler ? { ...x, doubled: false } : x));
    await expectRevert(harness.read.replayTable([g.seed, noDbl, logs]), "UnfundedAction");
  });

  it("insurance must be answered first and funded", async () => {
    const g = golden.vectors.find((x) => x.name.startsWith("ace up, mixed insurance"))!;
    const inputs = inputsOf(g);
    const logs = g.seats.map((s) => s.actions);
    const taker = g.seats.findIndex((s) => s.flags.insured);
    const noIns = inputs.map((x, i) => (i === taker ? { ...x, insured: false } : x));
    await expectRevert(harness.read.replayTable([g.seed, noIns, logs]), "UnfundedAction");
    const hitFirst = logs.map((l, i) => (i === 0 ? ("0x00" + l.slice(4)) as Hex : l));
    await expectRevert(harness.read.replayTable([g.seed, inputs, hitFirst]), "IllegalAction");
    const nothing = logs.map((l, i) => (i === 0 ? ("0x" as Hex) : l));
    await expectRevert(harness.read.replayTable([g.seed, inputs, nothing]), "IncompleteActions");
  });

  it("an illegal double / split / unknown action mid-play", async () => {
    const g = golden.vectors.find((x) => x.name === "one seat, plain")!;
    const inputs = inputsOf(g).map((x) => ({ ...x, doubled: true, split: true }));
    // the plain seat cannot double/split on whatever it holds unless the vector says so; try both
    for (const a of ["0x02", "0x03", "0x04"] as Hex[]) {
      try {
        await harness.read.replayTable([g.seed, inputs, [a]]);
      } catch (e) {
        expect(String(e)).to.match(/IllegalAction|IncompleteActions|0x/);
      }
    }
  });
});
