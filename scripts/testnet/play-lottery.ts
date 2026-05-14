/**
 * Testnet TicketLottery full draw cycle.
 *
 *   npx hardhat run scripts/testnet/play-lottery.ts --network arbitrumSepolia
 *
 * TicketLottery talks to the Chainlink VRF coordinator DIRECTLY (not via
 * RandomProvider). So we:
 *   1. operator calls requestWinners(players, tickets, numWinners)
 *   2. wait for LotteryFulfilled (Chainlink VRF callback fills randomWord
 *      and the contract selects winners weighted by ticket counts)
 *   3. read getLotteryResult(requestId) and report winners.
 */

import {
  loadTestnetContext, banner, step, ok, info, warn,
  waitForRequestEvent,
  type TestnetContext,
} from "./play-lib.js";

type Addr = `0x${string}`;

async function main() {
  const ctx = await loadTestnetContext();
  const lottery = await ctx.viem.getContractAt(
    "TicketLottery", ctx.deployment.contracts.ticketLottery,
  );
  const lotteryAsOp = await ctx.viem.getContractAt(
    "TicketLottery", ctx.deployment.contracts.ticketLottery,
    { client: { wallet: ctx.walletClients.operator } },
  );

  banner("TESTNET TICKET LOTTERY DRAW");
  info(`Operator:  ${ctx.wallets.operator.address}`);
  info(`Player1:   ${ctx.wallets.player1.address}`);
  info(`Player2:   ${ctx.wallets.player2.address}`);

  // Pick 2 winners out of 3 entrants with weighted tickets
  const entrants: Addr[] = [
    ctx.wallets.player1.address,
    ctx.wallets.player2.address,
    ctx.wallets.operator.address, // operator joins their own lottery as a third entrant
  ];
  const tickets = [50n, 30n, 20n]; // player1 favored, then player2, then operator
  const numWinners = 2;

  step(`Operator calls requestWinners(entrants=[p1,p2,op], tickets=[50,30,20], numWinners=${numWinners})`);
  const txHash = await lotteryAsOp.write.requestWinners([entrants, tickets, numWinners]);
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  ok(`requestWinners tx mined at block ${receipt.blockNumber}`);

  // Extract the lottery's requestId from the LotteryRequested event it just emitted
  const requestedEvents = await lottery.getEvents.LotteryRequested({}, {
    fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
  });
  if (requestedEvents.length === 0) {
    throw new Error(`No LotteryRequested event in tx ${txHash}`);
  }
  const requestId = requestedEvents[requestedEvents.length - 1].args.requestId!;
  info(`Lottery requestId = ${requestId}`);

  step("Waiting for Chainlink VRF to fulfill on the lottery contract directly");
  const fulfilled = await waitForRequestEvent<{
    requestId: bigint; winners: readonly Addr[]; randomWord: bigint;
  }>(lottery, "LotteryFulfilled", requestId, receipt.blockNumber, {
    label: "LotteryFulfilled",
    // VRF on the coordinator (no RandomProvider in between) usually fulfills slightly faster
  });
  ok(`LotteryFulfilled, randomWord = 0x${fulfilled.randomWord.toString(16).slice(0, 12)}…`);

  banner("RESULTS");
  const [winners, randomWord, returnedPlayers, returnedTickets, totalTickets] =
    await lottery.read.getLotteryResult([requestId]);
  info(`totalTickets: ${totalTickets}`);
  info(`randomWord:   0x${randomWord.toString(16)}`);
  console.log(`\n  Players + tickets:`);
  for (let i = 0; i < returnedPlayers.length; i++) {
    console.log(`    ${returnedPlayers[i]}  tickets=${returnedTickets[i]}`);
  }
  console.log(`\n  Selected winners (${winners.length}):`);
  for (let i = 0; i < winners.length; i++) {
    const tag =
      winners[i].toLowerCase() === ctx.wallets.player1.address.toLowerCase() ? " (player1)"
      : winners[i].toLowerCase() === ctx.wallets.player2.address.toLowerCase() ? " (player2)"
      : winners[i].toLowerCase() === ctx.wallets.operator.address.toLowerCase() ? " (operator)"
      : "";
    console.log(`    ${i + 1}. ${winners[i]}${tag}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error("\n✖ Play-lottery failed:", e);
  process.exit(1);
});
