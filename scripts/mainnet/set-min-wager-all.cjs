/* Owner op: lower the minimum wager of every live game to --min (default 0.05 EVA). Dry-run by default.
 *   node scripts/mainnet/set-min-wager-all.cjs [--min 0.05] [--only crash,mines,plinko,roulette,horse,tigrinho] [--execute]
 * Per game:
 *   crash     setBetLimits(min, currentMax)
 *   mines     setTableConfig({...current, minWager})          (Penalty bets through this contract)
 *   plinko    setBetLimits(min, currentMax)                   (limit applies to the TOTAL wager)
 *   roulette  setTableConfig({...current table, minWager})    (appends a new table version)
 *   horse     setBetTier(min, true)                           (adds a tier; existing tiers stay)
 *   tigrinho  setConfig(i, {...current, minWager}, currentTiers) for the configs the client uses (0,1,2):
 *             a config version is immutable, so the full tier table is read back with tierAt (cumulative
 *             bounds, converted back to per-tier shares) and re-sent.
 * Jackpot direct bet (fixed-cost tiers) and MultiLineSlots (unconfigured) are left alone on purpose.
 * Signs with MAINNET_DEPLOYER_PRIVATE_KEY (owner of all six).
 */
require("dotenv").config();
const fs = require("node:fs");
const { createPublicClient, createWalletClient, http, formatEther, parseEther } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { arbitrum } = require("viem/chains");

const argv = process.argv.slice(2);
const execute = argv.includes("--execute");
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const MIN = parseEther(opt("--min", "0.05"));
const ONLY = new Set((opt("--only", "crash,mines,plinko,roulette,horse,tigrinho")).split(",").map((s) => s.trim()));
const TIGRINHO_CONFIGS = [0, 1, 2]; // linesToConfigIndex in the Tigrinho client: 1 line → 0, 3 → 1, 5 → 2
const art = (p) => JSON.parse(fs.readFileSync(`artifacts/contracts/${p}`, "utf8")).abi;
const G = {
  crash: { address: "0xB4BC65A1624a1ea5DE0B73337bd959e6BCcD90ef", abi: art("games/crash/CrashGame.sol/CrashGame.json") },
  mines: { address: "0x02A6270c3f9b345d5fccC4763AbB8e15eB0349d2", abi: art("games/MinesGameHybrid.sol/MinesGameHybridV2.json") },
  plinko: { address: "0x383Ab4f4dff942DE5DB625aFB9a29ba0b1A9937d", abi: art("games/Plinko.sol/Plinko.json") },
  roulette: { address: "0x1C29464409746D1d38Eb6405562fBC87aB13342C", abi: art("games/SingleRandomRoulette.sol/SingleRandomRoulette.json") },
  horse: { address: "0x7B614cf2dBd4b4af6DD1C9444C4e3A3097150191", abi: art("games/horserace/HorseRaceGame.sol/HorseRaceGame.json") },
  tigrinho: { address: "0x3521726D955D6596D6938B169AEF98C48516F1D6", abi: art("games/SlotsTable.sol/SlotsTable.json") },
};
const E = (v) => formatEther(v);

(async () => {
  const pk = (process.env.MAINNET_DEPLOYER_PRIVATE_KEY ?? "").trim();
  if (!pk) throw new Error("MAINNET_DEPLOYER_PRIVATE_KEY missing");
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk);
  const transport = http(process.env.MAINNET_ARBITRUM_RPC_URL);
  const pub = createPublicClient({ chain: arbitrum, transport });
  const wallet = createWalletClient({ chain: arbitrum, transport, account });
  const read = (g, functionName, args = []) => pub.readContract({ ...G[g], functionName, args });
  for (const g of ONLY) { const o = await read(g, "owner"); if (o.toLowerCase() !== account.address.toLowerCase()) throw new Error(`signer is not owner of ${g} (${o})`); }
  console.log(`${execute ? "EXECUTE" : "DRY RUN"} · signer ${account.address} · ETH ${E(await pub.getBalance({ address: account.address }))} · target min ${E(MIN)} EVA · games: ${[...ONLY].join(", ")}\n`);

  const plan = []; // { label, game, functionName, args, gas? }

  if (ONLY.has("crash")) {
    const cfg = await read("crash", "getConfig");
    console.log(`crash     min ${E(cfg.minBetAmount)} → ${E(MIN)} · max ${E(cfg.maxBetAmount)} (unchanged)${cfg.minBetAmount === MIN ? "  [already]" : ""}`);
    if (MIN > cfg.maxBetAmount) throw new Error("crash: min > max");
    if (cfg.minBetAmount !== MIN) plan.push({ label: "crash.setBetLimits", game: "crash", functionName: "setBetLimits", args: [MIN, cfg.maxBetAmount] });
  }
  if (ONLY.has("mines")) {
    const m = await read("mines", "tableConfig");
    console.log(`mines     min ${E(m[3])} → ${E(MIN)} · max ${E(m[4])} · mines ${m[1]}–${m[2]} · claimTimeout ${m[5]} (unchanged)${m[3] === MIN ? "  [already]" : ""}`);
    if (MIN > m[4]) throw new Error("mines: min > max");
    if (m[3] !== MIN) plan.push({ label: "mines.setTableConfig", game: "mines", functionName: "setTableConfig", args: [{ enabled: m[0], minMines: m[1], maxMines: m[2], minWager: MIN, maxWager: m[4], claimTimeout: m[5] }] });
  }
  if (ONLY.has("plinko")) {
    const [mn, mx] = await Promise.all([read("plinko", "minBet"), read("plinko", "maxBet")]);
    console.log(`plinko    min ${E(mn)} → ${E(MIN)} · max ${E(mx)} (unchanged)${mn === MIN ? "  [already]" : ""}`);
    if (MIN > mx) throw new Error("plinko: min > max");
    if (mn !== MIN) plan.push({ label: "plinko.setBetLimits", game: "plinko", functionName: "setBetLimits", args: [MIN, mx] });
  }
  if (ONLY.has("roulette")) {
    const t = await read("roulette", "getTableConfig");
    console.log(`roulette  min ${E(t.minWager)} → ${E(MIN)} · max ${E(t.maxWager)} · mult x${t.minMultiplier / 100}–x${t.maxMultiplier / 100} · replay ${t.replayBps / 100}% · jackpot ${t.jackpotBps / 100}% (unchanged; new table version)${t.minWager === MIN ? "  [already]" : ""}`);
    if (MIN > t.maxWager) throw new Error("roulette: min > max");
    if (t.minWager !== MIN) plan.push({ label: "roulette.setTableConfig", game: "roulette", functionName: "setTableConfig", args: [{ enabled: t.enabled, replayBps: t.replayBps, jackpotBps: t.jackpotBps, minMultiplier: t.minMultiplier, maxMultiplier: t.maxMultiplier, minWager: MIN, maxWager: t.maxWager }] });
  }
  if (ONLY.has("horse")) {
    const has = await read("horse", "allowedBetAmounts", [MIN]);
    const others = await Promise.all([parseEther("0.1"), parseEther("0.2")].map((a) => read("horse", "allowedBetAmounts", [a])));
    console.log(`horse     tier ${E(MIN)} ${has ? "already enabled" : "→ enable"} · existing tiers 0.1:${others[0]} 0.2:${others[1]} (kept)`);
    if (!has) plan.push({ label: `horse.setBetTier(${E(MIN)}, true)`, game: "horse", functionName: "setBetTier", args: [MIN, true] });
  }
  if (ONLY.has("tigrinho")) {
    for (const ci of TIGRINHO_CONFIGS) {
      const vi = await read("tigrinho", "activeVersion", [ci]);
      const v = await read("tigrinho", "configVersions", [vi]); // (tierBlobPtr, tierCount?, maxMult, cachedRtpBps, enabled, minWager, maxWager)
      const n = Number(await read("tigrinho", "tierCount", [ci]));
      const tiers = [];
      for (let i = 0; i < n; i += 200) { const idx = []; for (let j = i; j < Math.min(i + 200, n); j++) idx.push(j); const res = await pub.multicall({ contracts: idx.map((j) => ({ ...G.tigrinho, functionName: "tierAt", args: [ci, BigInt(j)] })) }); for (const r of res) { if (r.status !== "success") throw new Error("tierAt failed"); tiers.push({ probability: r.result[0], payoutMultiplierHundredths: r.result[1] }); } }
      // tierAt returns the CUMULATIVE upper bound of each tier; setConfig wants per-tier shares.
      for (let i = tiers.length - 1; i > 0; i--) tiers[i].probability -= tiers[i - 1].probability;
      const sum = tiers.reduce((s, t) => s + t.probability, 0n);
      const enabled = v[4], minWager = v[5], maxWager = v[6];
      console.log(`tigrinho  config ${ci} (version ${vi}) · enabled ${enabled} · min ${E(minWager)} → ${E(MIN)} · max ${E(maxWager)} · ${n} tiers re-sent (Σp ${sum}) · rtp ${await read("tigrinho", "getRtpBps", [ci])} bps${minWager === MIN ? "  [already]" : ""}`);
      if (MIN > maxWager) throw new Error(`tigrinho ${ci}: min > max`);
      if (minWager !== MIN) plan.push({ label: `tigrinho.setConfig(${ci})`, game: "tigrinho", functionName: "setConfig", args: [ci, { enabled, minWager: MIN, maxWager, maxMultiplierHundredths: 0, cachedRtpBps: 0 }, tiers] });
    }
  }

  console.log(`\n${plan.length} transaction(s) planned.`);
  for (const p of plan) { try { const gas = await pub.estimateContractGas({ ...G[p.game], functionName: p.functionName, args: p.args, account }); p.gas = gas; console.log(`  ${p.label.padEnd(30)} est. gas ${gas}`); } catch (e) { console.log(`  ${p.label.padEnd(30)} SIMULATION FAILED: ${(e.shortMessage ?? e.message).split("\n")[0]}`); p.failed = true; } }
  if (plan.some((p) => p.failed)) throw new Error("fix the failing simulations before executing");
  if (!execute) { console.log("\ndry run only. Re-run with --execute to send."); return; }

  let nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
  for (const p of plan) {
    const h = await wallet.writeContract({ ...G[p.game], functionName: p.functionName, args: p.args, nonce: nonce++, gas: p.gas ? (p.gas * 13n) / 10n : undefined });
    const rc = await pub.waitForTransactionReceipt({ hash: h });
    console.log(`${p.label} → ${rc.status} ${h}`);
    if (rc.status !== "success") throw new Error(`${p.label} reverted`);
  }
  console.log("\nverify:");
  if (ONLY.has("crash")) console.log(`  crash min ${E((await read("crash", "getConfig")).minBetAmount)}`);
  if (ONLY.has("mines")) console.log(`  mines min ${E((await read("mines", "tableConfig"))[3])}`);
  if (ONLY.has("plinko")) console.log(`  plinko min ${E(await read("plinko", "minBet"))}`);
  if (ONLY.has("roulette")) console.log(`  roulette min ${E((await read("roulette", "getTableConfig")).minWager)}`);
  if (ONLY.has("horse")) console.log(`  horse tier ${E(MIN)} enabled ${await read("horse", "allowedBetAmounts", [MIN])}`);
  if (ONLY.has("tigrinho")) for (const ci of TIGRINHO_CONFIGS) { const v = await read("tigrinho", "configVersions", [await read("tigrinho", "activeVersion", [ci])]); console.log(`  tigrinho config ${ci} min ${E(v[5])} rtp ${await read("tigrinho", "getRtpBps", [ci])} bps`); }
})().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });
