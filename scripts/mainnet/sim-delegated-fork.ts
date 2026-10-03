/* Delegated-betting rehearsal on a local fork of Arbitrum One at the CURRENT block. Nothing is sent to mainnet.
 * Mirrors what the Shell + operatorsServer do for a player:
 *   1. player authorizes a session key on AuthHub (with a spend cap),
 *   2. the session key signs each action (EIP-712, per-game domain, per-game nonce),
 *   3. a REAL production operator wallet (impersonated) submits the *For entry — single calls and one multicallTry batch,
 *   4. the coordinator fulfils (impersonated fulfiller) and the game settles.
 * Then negative cases: replayed signature, wrong signer, non-operator sender, spend cap exceeded.
 *   npx hardhat run scripts/mainnet/sim-delegated-fork.ts --network hardhatArbitrum
 */
import { network } from "hardhat";
import { decodeErrorResult, decodeEventLog, encodeFunctionData, formatEther, keccak256, toHex, pad, parseAbi, parseEther, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import "dotenv/config";
import { readFileSync } from "node:fs";

const RP = "0x6AA57111D6f5970565DC355F87Aa75e1609BE3D4" as const;
const COORD = "0x508570778d279eCF89D99e23831dF4d62c6adEfB" as const;
const EVA = "0x45D9831d8751B2325f3DBf48db748723726e1C8c" as const;
const PH = "0x2a8a553451ba5C14d7A1EE4d3D7D1d2bE6F819e8" as const;
const AUTH_HUB = "0x86543287d870f30dd21320Dd10451Bf33E64f775" as const;
const ROULETTE = "0x1C29464409746D1d38Eb6405562fBC87aB13342C" as const;
const MINES = "0x02A6270c3f9b345d5fccC4763AbB8e15eB0349d2" as const;
const PLINKO = "0x383Ab4f4dff942DE5DB625aFB9a29ba0b1A9937d" as const;
const SLOTS = "0x3521726D955D6596D6938B169AEF98C48516F1D6" as const;
const CRASH = "0xB4BC65A1624a1ea5DE0B73337bd959e6BCcD90ef" as const;
const PLAYER = "0xe7E486F42FD93148978fE83326be7F3ce8E3a16a" as const; // deployer wallet
const OPERATOR = "0xf70aFd9b4774c98835A50b22A58D02c29E79a104" as const; // operatorsServer wallet #1 (from /health)
const FULFILLER = "0xD99e6fC2A648F632fE5eAfE571E1917ED68DF7B5" as const;
const CRASH_OPERATOR = "0x22172ca222D61F2bA6C86132e49E8267d153Ab21" as const;
const RANDO = "0x000000000000000000000000000000000000dEaD" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const SPEND_CAP = parseEther("2"); // EVA the session key may spend in total

const art = (p: string) => JSON.parse(readFileSync(`artifacts/contracts/${p}`, "utf8")).abi as Abi;
const abis = {
  coordinator: art("core/RandomCoordinator.sol/RandomCoordinator.json"),
  rp: art("core/RandomProvider.sol/RandomProvider.json"),
  authHub: art("auth/AuthHub.sol/AuthHub.json"),
  roulette: art("games/SingleRandomRoulette.sol/SingleRandomRoulette.json"),
  mines: art("games/MinesGameHybrid.sol/MinesGameHybridV2.json"),
  plinko: art("games/Plinko.sol/Plinko.json"),
  slots: art("games/SlotsTable.sol/SlotsTable.json"),
  crash: art("games/crash/CrashGame.sol/CrashGame.json"),
};
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const eip712Abi = parseAbi(["function eip712Domain() view returns (bytes1 fields,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt,uint256[] extensions)", "function getActionNonce(address) view returns (uint256)"]);

const TYPES = {
  roulette: { StartSpin: [{ name: "game", type: "address" }, { name: "player", type: "address" }, { name: "wager", type: "uint256" }, { name: "multiplierHundredths", type: "uint256" }, { name: "potentialReferrer", type: "address" }, { name: "participateInJackpot", type: "bool" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
  mines: { StartGame: [{ name: "game", type: "address" }, { name: "player", type: "address" }, { name: "wager", type: "uint256" }, { name: "minesCount", type: "uint8" }, { name: "potentialReferrer", type: "address" }, { name: "commit", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
  plinko: { PlaceBet: [{ name: "game", type: "address" }, { name: "player", type: "address" }, { name: "betAmount", type: "uint256" }, { name: "rows", type: "uint8" }, { name: "risk", type: "uint8" }, { name: "numDrops", type: "uint8" }, { name: "potentialReferrer", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
  slots: { PlaceBet: [{ name: "game", type: "address" }, { name: "player", type: "address" }, { name: "configIndex", type: "uint32" }, { name: "wager", type: "uint256" }, { name: "referrer", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
  crash: { PlaceBet: [{ name: "game", type: "address" }, { name: "player", type: "address" }, { name: "amount", type: "uint256" }, { name: "autoCashoutMultiplier", type: "uint32" }, { name: "referrer", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
} as const;

async function main() {
  const conn = await network.connect({ network: "hardhatArbitrum", override: { forking: { url: process.env.MAINNET_ARBITRUM_RPC_URL!, enabled: true } } } as any);
  const pub = await conn.viem.getPublicClient();
  const p = conn.provider;
  await p.request({ method: "evm_mine", params: [] });
  for (const a of [PLAYER, OPERATOR, FULFILLER, CRASH_OPERATOR, RANDO]) { await p.request({ method: "hardhat_impersonateAccount", params: [a] }); await p.request({ method: "hardhat_setBalance", params: [a, "0x56BC75E2D63100000"] }); }
  const player = await conn.viem.getWalletClient(PLAYER);
  const operator = await conn.viem.getWalletClient(OPERATOR);
  const rando = await conn.viem.getWalletClient(RANDO);
  const fulfiller = await conn.viem.getWalletClient(FULFILLER);
  const crashOp = await conn.viem.getWalletClient(CRASH_OPERATOR);
  const sessionKey = privateKeyToAccount(generatePrivateKey()); // what the Shell generates in the browser
  const chainId = BigInt(await pub.getChainId());
  const now = () => pub.getBlock({ blockTag: "latest" }).then((b) => b.timestamp);

  const rc = async (hash: Hex) => { const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== "success") throw new Error("tx reverted " + hash); return r; };
  const requestIdOf = (logs: readonly any[]) => { for (const l of logs) { if (l.address.toLowerCase() !== COORD.toLowerCase()) continue; try { const d = decodeEventLog({ abi: abis.coordinator, data: l.data, topics: l.topics }) as any; if (d.eventName === "RandomWordsRequested") return d.args.requestId as bigint; } catch { /* */ } } return null; };
  const decodeAll = (logs: readonly any[]) => { const out: string[] = []; for (const l of logs) { let hit = false; for (const [n, abi] of Object.entries(abis)) { try { const d = decodeEventLog({ abi, data: l.data, topics: l.topics }) as any; const a = d.args ?? {}; const extra = d.eventName === "SpinResolved" ? `(outcome ${a.outcome}, payout ${formatEther(a.payout)})` : d.eventName === "BetSettled" ? `(payout ${formatEther(a.payout)})` : d.eventName === "SpendingRecorded" ? `(+${formatEther(a.amount)} → spent ${formatEther(a.newSpent)})` : ""; out.push(`${n}.${d.eventName}${extra}`); hit = true; break; } catch { /* next */ } } if (!hit) out.push(`${l.address.slice(0, 8)}.?`); } return out; };
  const fulfill = async (id: bigint) => { const word = BigInt(keccak256(pad(toHex(id), { size: 32 }))); const r = await rc(await fulfiller.writeContract({ address: COORD, abi: abis.coordinator, functionName: "fulfillMany", args: [[id], [word]], gas: 3_000_000n })); const st = (await pub.readContract({ address: RP, abi: abis.rp, functionName: "getRequestStatus", args: [id] })) as number; return { r, st }; };
  const domainOf = async (game: `0x${string}`) => { const d = (await pub.readContract({ address: game, abi: eip712Abi, functionName: "eip712Domain" })) as any; return { name: d[1] as string, version: d[2] as string, chainId, verifyingContract: game }; };
  const nonceOf = (game: `0x${string}`) => pub.readContract({ address: game, abi: eip712Abi, functionName: "getActionNonce", args: [PLAYER] }) as Promise<bigint>;
  const sign = async (game: `0x${string}`, types: any, primaryType: string, message: Record<string, unknown>, signer = sessionKey) => signer.signTypedData({ domain: await domainOf(game), types, primaryType, message } as any);
  const remaining = () => pub.readContract({ address: AUTH_HUB, abi: abis.authHub, functionName: "remainingSpend", args: [PLAYER] }) as Promise<bigint>;
  const shortErr = (e: any) => {
    const texts: string[] = []; const hexes: string[] = [];
    for (let c: any = e, i = 0; c && i < 8; c = c.cause, i++) { for (const k of ["shortMessage", "message", "details", "reason"]) if (typeof c[k] === "string") texts.push(c[k]); if (Array.isArray(c.metaMessages)) texts.push(...c.metaMessages); if (typeof c.data === "string") hexes.push(c.data); if (c.data && typeof c.data.data === "string") hexes.push(c.data.data); }
    for (const t of texts) for (const m of t.matchAll(/0x[0-9a-fA-F]{8,}/g)) hexes.push(m[0]);
    for (const h of hexes) for (const abi of Object.values(abis)) { try { const d = decodeErrorResult({ abi, data: h as Hex }); return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`; } catch { /* next */ } }
    const named = texts.join(" ").match(/(InvalidNonce|InvalidSignature|NotOperator|ExpiredDeadline|NoSessionKey|SpendCapExceeded|WrongGame|[A-Z][A-Za-z]+Exceeded|[A-Z][A-Za-z]+TooLow)/);
    if (named) return named[1];
    return (texts.find((t) => !/unknown RPC error/i.test(t)) ?? texts[0] ?? String(e)).split("\n")[0].trim();
  };

  // ── preflight ────────────────────────────────────────────────────────────────────────────────────────────────
  console.log(`fork block ${await pub.getBlockNumber()} · player ${PLAYER} · EVA ${formatEther(await pub.readContract({ address: EVA, abi: erc20, functionName: "balanceOf", args: [PLAYER] }))}`);
  console.log(`operator ${OPERATOR} isOperator=${await pub.readContract({ address: AUTH_HUB, abi: abis.authHub, functionName: "isOperator", args: [OPERATOR] })}`);
  for (const [n, g] of Object.entries({ roulette: ROULETTE, mines: MINES, plinko: PLINKO, slots: SLOTS, crash: CRASH })) console.log(`  spendTracker[${n}] = ${await pub.readContract({ address: AUTH_HUB, abi: abis.authHub, functionName: "spendTrackers", args: [g] })}`);
  const prevKey = await pub.readContract({ address: AUTH_HUB, abi: abis.authHub, functionName: "sessionKeyOf", args: [PLAYER] });
  console.log(`player's current session key on mainnet: ${prevKey}`);

  // step 1: player authorizes a fresh session key with a 2 EVA cap (exactly what onboarding does; fork only)
  await rc(await player.writeContract({ address: AUTH_HUB, abi: abis.authHub, functionName: "authorize", args: [sessionKey.address, 0n, SPEND_CAP] }));
  for (const spender of [PH, ROULETTE, MINES, PLINKO, SLOTS, CRASH]) await rc(await player.writeContract({ address: EVA, abi: erc20, functionName: "approve", args: [spender, 10n ** 24n] }));
  console.log(`session key ${sessionKey.address} authorized · cap ${formatEther(SPEND_CAP)} EVA · remaining ${formatEther(await remaining())}\n`);

  let ok = 0, failed = 0;
  const run = async (name: string, fn: () => Promise<string>) => { try { const out = await fn(); ok++; console.log(`✓ ${name}\n    ${out}`); } catch (e: any) { failed++; console.log(`✗ ${name}\n    ${shortErr(e)}`); } };
  const expectRevert = async (name: string, re: RegExp, fn: () => Promise<unknown>) => { try { await fn(); failed++; console.log(`✗ ${name}: did NOT revert`); } catch (e: any) { const m = shortErr(e); if (re.test(m)) { ok++; console.log(`✓ ${name} → ${m}`); } else { failed++; console.log(`✗ ${name}: unexpected error ${m}`); } } };
  const settle = async (bet: { gasUsed: bigint; logs: readonly any[] }, after?: () => Promise<string>) => {
    const id = requestIdOf(bet.logs); if (!id) throw new Error("no coordinator request: " + decodeAll(bet.logs).join(", "));
    const { r, st } = await fulfill(id);
    const extra = after ? " · " + (await after()) : "";
    if (st !== 2) throw new Error(`RP status ${st} after fulfill`);
    return `bet gas ${bet.gasUsed} · bet events: ${decodeAll(bet.logs).filter((x) => !/Transfer|Approval/.test(x)).join(", ")}\n    fulfill gas ${r.gasUsed} · ${decodeAll(r.logs).filter((x) => /Resolved|Settled|Fulfilled|Started|Crash/.test(x)).join(", ")}${extra} · remaining cap ${formatEther(await remaining())} EVA`;
  };
  const dl = async () => (await now()) + 300n;

  // ── delegated bets, one per game ──────────────────────────────────────────────────────────────────────────────
  await run("Roulette startSpinFor 0.1 EVA @2.00x + jackpot", async () => {
    const m = { game: ROULETTE, player: PLAYER, wager: parseEther("0.1"), multiplierHundredths: 200n, potentialReferrer: ZERO, participateInJackpot: true, nonce: await nonceOf(ROULETTE), deadline: await dl() };
    const sig = await sign(ROULETTE, TYPES.roulette, "StartSpin", m);
    return settle(await rc(await operator.writeContract({ address: ROULETTE, abi: abis.roulette, functionName: "startSpinFor", args: [m.player, m.wager, m.multiplierHundredths, m.potentialReferrer, m.participateInJackpot, m.nonce, m.deadline, sig] })));
  });
  await run("Plinko placeBetFor 0.1 EVA, 8 rows, medium, 1 drop", async () => {
    const m = { game: PLINKO, player: PLAYER, betAmount: parseEther("0.1"), rows: 8, risk: 1, numDrops: 1, potentialReferrer: ZERO, nonce: await nonceOf(PLINKO), deadline: await dl() };
    const sig = await sign(PLINKO, TYPES.plinko, "PlaceBet", m);
    return settle(await rc(await operator.writeContract({ address: PLINKO, abi: abis.plinko, functionName: "placeBetFor", args: [m.player, m.betAmount, m.rows, m.risk, m.numDrops, m.potentialReferrer, m.nonce, m.deadline, sig] })));
  });
  await run("Tigrinho placeBetFor 0.1 EVA config 0", async () => {
    const m = { game: SLOTS, player: PLAYER, configIndex: 0, wager: parseEther("0.1"), referrer: ZERO, nonce: await nonceOf(SLOTS), deadline: await dl() };
    const sig = await sign(SLOTS, TYPES.slots, "PlaceBet", m);
    return settle(await rc(await operator.writeContract({ address: SLOTS, abi: abis.slots, functionName: "placeBetFor", args: [m.player, m.configIndex, m.wager, m.referrer, m.nonce, m.deadline, sig] })));
  });
  await run("Mines startGameFor 0.1 EVA, 3 mines", async () => {
    const m = { game: MINES, player: PLAYER, wager: parseEther("0.1"), minesCount: 3, potentialReferrer: ZERO, commit: keccak256(toHex("sim-secret")), nonce: await nonceOf(MINES), deadline: await dl() };
    const sig = await sign(MINES, TYPES.mines, "StartGame", m);
    const bet = await rc(await operator.writeContract({ address: MINES, abi: abis.mines, functionName: "startGameFor", args: [m.player, m.wager, m.minesCount, m.potentialReferrer, m.commit, m.nonce, m.deadline, sig] }));
    const id = requestIdOf(bet.logs)!;
    return settle(bet, async () => { const g = (await pub.readContract({ address: MINES, abi: abis.mines, functionName: "games", args: [id] })) as any; return `mines game status ${g[8]} (random stored, player reveals later)`; });
  });
  await run("Crash placeBetFor 0.2 EVA auto 2.00x (round by crash operator)", async () => {
    const created = await rc(await crashOp.writeContract({ address: CRASH, abi: abis.crash, functionName: "createRound", args: [keccak256(toHex("sim-crash-commit"))] }));
    const m = { game: CRASH, player: PLAYER, amount: parseEther("0.2"), autoCashoutMultiplier: 20000, referrer: ZERO, nonce: await nonceOf(CRASH), deadline: await dl() };
    const sig = await sign(CRASH, TYPES.crash, "PlaceBet", m);
    const bet = await rc(await operator.writeContract({ address: CRASH, abi: abis.crash, functionName: "placeBetFor", args: [m.player, m.amount, m.autoCashoutMultiplier, m.referrer, m.nonce, m.deadline, sig] }));
    const start = await rc(await crashOp.writeContract({ address: CRASH, abi: abis.crash, functionName: "startRound" }));
    return settle({ gasUsed: bet.gasUsed, logs: [...created.logs, ...bet.logs, ...start.logs] }, async () => { const r = (await pub.readContract({ address: CRASH, abi: abis.crash, functionName: "getCurrentRound" })) as any; return `crash round ${r.roundId} state ${r.state} (4=Crashed) vrfWord ${r.vrfRandomWord !== 0n ? "SET" : "0"}`; });
  });

  // ── batched relay: 3 roulette spins in one multicallTry, like operatorsServer does per tick ───────────────────
  await run("Roulette ×3 in one multicallTry (batched relay)", async () => {
    const n0 = await nonceOf(ROULETTE); const deadline = await dl(); const calls: Hex[] = [];
    for (let i = 0; i < 3; i++) {
      const m = { game: ROULETTE, player: PLAYER, wager: parseEther("0.1"), multiplierHundredths: BigInt(200 + i * 100), potentialReferrer: ZERO, participateInJackpot: false, nonce: n0 + BigInt(i), deadline };
      const sig = await sign(ROULETTE, TYPES.roulette, "StartSpin", m);
      calls.push(encodeFunctionData({ abi: abis.roulette, functionName: "startSpinFor", args: [m.player, m.wager, m.multiplierHundredths, m.potentialReferrer, m.participateInJackpot, m.nonce, m.deadline, sig] }));
    }
    const r = await rc(await operator.writeContract({ address: ROULETTE, abi: abis.roulette, functionName: "multicallTry", args: [calls], gas: 3_000_000n }));
    const ids = r.logs.filter((l) => l.address.toLowerCase() === COORD.toLowerCase()).map((l) => { try { const d = decodeEventLog({ abi: abis.coordinator, data: l.data, topics: l.topics }) as any; return d.eventName === "RandomWordsRequested" ? (d.args.requestId as bigint) : null; } catch { return null; } }).filter((x): x is bigint => x !== null);
    const words = ids.map((id) => BigInt(keccak256(pad(toHex(id), { size: 32 }))));
    const f = await rc(await fulfiller.writeContract({ address: COORD, abi: abis.coordinator, functionName: "fulfillMany", args: [ids, words], gas: 5_000_000n }));
    return `batch gas ${r.gasUsed} for ${ids.length} spins (${(r.gasUsed / BigInt(ids.length || 1)).toString()}/spin) · fulfillMany gas ${f.gasUsed} · ${decodeAll(f.logs).filter((x) => /SpinResolved/.test(x)).join(", ")} · remaining cap ${formatEther(await remaining())} EVA`;
  });

  // ── negative cases ────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nnegative cases:");
  const base = async () => ({ game: ROULETTE, player: PLAYER, wager: parseEther("0.1"), multiplierHundredths: 200n, potentialReferrer: ZERO, participateInJackpot: false, nonce: await nonceOf(ROULETTE), deadline: await dl() });
  const relay = (m: any, sig: Hex, from = operator) => from.writeContract({ address: ROULETTE, abi: abis.roulette, functionName: "startSpinFor", args: [m.player, m.wager, m.multiplierHundredths, m.potentialReferrer, m.participateInJackpot, m.nonce, m.deadline, sig] });
  { const m = await base(); const sig = await sign(ROULETTE, TYPES.roulette, "StartSpin", m); const used = await rc(await relay(m, sig)); await fulfill(requestIdOf(used.logs)!);
    await expectRevert("replay of an already-used signature", /InvalidNonce/, () => relay(m, sig)); }
  { const m = await base(); const sig = await sign(ROULETTE, TYPES.roulette, "StartSpin", m, privateKeyToAccount(generatePrivateKey()));
    await expectRevert("signature from a key that is not the player's session key", /InvalidSignature/, () => relay(m, sig)); }
  { const m = await base(); const sig = await sign(ROULETTE, TYPES.roulette, "StartSpin", m);
    await expectRevert("valid signature submitted by a wallet that is not an operator", /NotOperator/, () => relay(m, sig, rando)); }
  { const m = { ...(await base()), deadline: (await now()) - 1n }; const sig = await sign(ROULETTE, TYPES.roulette, "StartSpin", m);
    await expectRevert("expired deadline", /ExpiredDeadline/, () => relay(m, sig)); }
  { const m = await base(); const sig = await sign(PLINKO, TYPES.roulette, "StartSpin", m); // signed under Plinko's domain
    await expectRevert("signature bound to another game's domain", /InvalidSignature/, () => relay(m, sig)); }
  { const left = await remaining(); const m = { ...(await base()), wager: left + parseEther("0.1") }; const sig = await sign(ROULETTE, TYPES.roulette, "StartSpin", m);
    await expectRevert(`wager above the remaining cap (${formatEther(left)} EVA left)`, /SpendCapExceeded/, () => relay(m, sig)); }
  { await rc(await player.writeContract({ address: AUTH_HUB, abi: abis.authHub, functionName: "revoke" })); const m = await base(); const sig = await sign(ROULETTE, TYPES.roulette, "StartSpin", m);
    await expectRevert("after the player revokes the session key", /NoSessionKey/, () => relay(m, sig)); }

  console.log(`\n${ok} ok · ${failed} failed · player EVA now ${formatEther(await pub.readContract({ address: EVA, abi: erc20, functionName: "balanceOf", args: [PLAYER] }))} · RP pending ${await pub.readContract({ address: RP, abi: abis.rp, functionName: "pendingRequestCount" })}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
