/* Fork rehearsal: a player authorizes a session key, approves EVA to BurnJackpotV2, and the real relay operator
 * submits playFor with the session-key signature. Nothing is sent to mainnet.
 *   npx hardhat run scripts/mainnet/sim-burnjackpot-fork.ts --network hardhatArbitrum */
import { network } from "hardhat";
import { decodeEventLog, encodeFunctionData, formatEther, parseAbi, parseEther, formatUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import "dotenv/config";
import { readFileSync } from "node:fs";
const B = "0x37b21dB9cA10a44eA03f9aCB7D77Cb79865847f8" as const, EVA = "0x45D9831d8751B2325f3DBf48db748723726e1C8c" as const, HUB = "0x86543287d870f30dd21320Dd10451Bf33E64f775" as const, WBTC = "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" as const;
const PLAYER = "0xe7E486F42FD93148978fE83326be7F3ce8E3a16a" as const, OPERATOR = "0xf70aFd9b4774c98835A50b22A58D02c29E79a104" as const;
const bj = parseAbi(["function multicallTry(bytes[] data) returns (bool[] successes, bytes[] results)", "function playFor(address player,uint256 amount,uint256 nonce,uint256 deadline,bytes signature) returns (uint256)", "function actionNonces(address) view returns (uint256)", "function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])", "function pot() view returns (uint256)", "function pool() view returns (uint256)", "event Played(uint256 indexed playId,address indexed player,uint256 amount,uint256 burned,uint256 wbtcAdded,uint256 potAfter,uint256 poolAfter)"]);
const erc = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const hub = JSON.parse(readFileSync("artifacts/contracts/auth/AuthHub.sol/AuthHub.json", "utf8")).abi;
async function main() {
  const conn = await network.connect({ network: "hardhatArbitrum", override: { forking: { url: process.env.MAINNET_ARBITRUM_RPC_URL!, enabled: true } } } as any);
  const pub = await conn.viem.getPublicClient(); const p = conn.provider; await p.request({ method: "evm_mine", params: [] });
  for (const a of [PLAYER, OPERATOR]) { await p.request({ method: "hardhat_impersonateAccount", params: [a] }); await p.request({ method: "hardhat_setBalance", params: [a, "0x56BC75E2D63100000"] }); }
  const player = await conn.viem.getWalletClient(PLAYER), operator = await conn.viem.getWalletClient(OPERATOR);
  const key = privateKeyToAccount(generatePrivateKey());
  const rc = async (h: `0x${string}`) => { const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== "success") throw new Error("reverted " + h); return r; };
  await rc(await player.writeContract({ address: HUB, abi: hub, functionName: "authorize", args: [key.address, 0n, parseEther("2")] }));
  await rc(await player.writeContract({ address: EVA, abi: erc, functionName: "approve", args: [B, parseEther("10")] }));
  const d = await pub.readContract({ address: B, abi: bj, functionName: "eip712Domain" });
  const domain = { name: d[1], version: d[2], chainId: BigInt(await pub.getChainId()), verifyingContract: B };
  const before = { eva: await pub.readContract({ address: EVA, abi: erc, functionName: "balanceOf", args: [PLAYER] }), pot: await pub.readContract({ address: B, abi: bj, functionName: "pot" }), pool: await pub.readContract({ address: B, abi: bj, functionName: "pool" }) };
  const nonce = await pub.readContract({ address: B, abi: bj, functionName: "actionNonces", args: [PLAYER] }); const deadline = (await pub.getBlock({ blockTag: "latest" })).timestamp + 300n; const amount = parseEther("0.1");
  const sig = await key.signTypedData({ domain, types: { Play: [{ name: "game", type: "address" }, { name: "player", type: "address" }, { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] }, primaryType: "Play", message: { game: B, player: PLAYER, amount, nonce, deadline } });
  const call = encodeFunctionData({ abi: bj, functionName: "playFor", args: [PLAYER, amount, nonce, deadline, sig] });
  const simRes = await pub.simulateContract({ address: B, abi: bj, functionName: "multicallTry", args: [[call]], account: OPERATOR });
  console.log("simulate result:", JSON.stringify(simRes.result, (k, v) => typeof v === "bigint" ? v.toString() : v));
  const [okArr, resArr] = simRes.result as unknown as [boolean[], `0x${string}`[]];
  if (!okArr[0]) { const { decodeErrorResult } = await import("viem"); let reason = resArr[0]; try { const d = decodeErrorResult({ abi: [...bj, ...hub, { type: "error", name: "NotOperator", inputs: [] }, { type: "error", name: "InvalidSignature", inputs: [] }, { type: "error", name: "InvalidNonce", inputs: [] }, { type: "error", name: "ExpiredDeadline", inputs: [] }, { type: "error", name: "NoSessionKey", inputs: [] }, { type: "error", name: "InvalidAmount", inputs: [] }, { type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] }, { type: "error", name: "NotAuthorizedMulticaller", inputs: [{ type: "address" }] }] as any, data: resArr[0] }); reason = d.errorName as any; } catch {} console.log("✗ sub-call failed inside multicallTry:", reason); process.exit(1); }
  const est = await pub.estimateContractGas({ address: B, abi: bj, functionName: "multicallTry", args: [[call]], account: OPERATOR });
  const r = await rc(await operator.writeContract({ address: B, abi: bj, functionName: "multicallTry", args: [[call]], gas: (est * 15n) / 10n })); // same 1.5× buffer the relay applies
  console.log("tx logs:", r.logs.length, r.logs.map((l) => l.address + " " + l.topics[0]?.slice(0, 10)).join(" | "));
  const ev = r.logs.map((l) => { try { return decodeEventLog({ abi: bj, data: l.data, topics: l.topics }) as any; } catch { return null; } }).find((e) => e?.eventName === "Played");
  const after = { eva: await pub.readContract({ address: EVA, abi: erc, functionName: "balanceOf", args: [PLAYER] }), pot: await pub.readContract({ address: B, abi: bj, functionName: "pot" }), pool: await pub.readContract({ address: B, abi: bj, functionName: "pool" }) };
  console.log(`✓ multicallTry→playFor by operator ${OPERATOR} · gas ${r.gasUsed} · playId ${ev?.args.playId} · burned ${formatEther(ev?.args.burned)} EVA → +${formatUnits(ev?.args.wbtcAdded, 8)} WBTC to the pot`);
  console.log(`  player EVA ${formatEther(before.eva)} → ${formatEther(after.eva)} · pot ${formatUnits(before.pot, 8)} → ${formatUnits(after.pot, 8)} WBTC · pool ${formatEther(before.pool)} → ${formatEther(after.pool)} EVA · nonce now ${await pub.readContract({ address: B, abi: bj, functionName: "actionNonces", args: [PLAYER] })}`);
  try { await operator.writeContract({ address: B, abi: bj, functionName: "playFor", args: [PLAYER, amount, nonce, deadline, sig] }); console.log("✗ replay accepted"); } catch { console.log("✓ replay of the same signature rejected"); }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
