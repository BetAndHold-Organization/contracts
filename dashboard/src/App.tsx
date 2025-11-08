import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useMetrics, usePlayers, usePlayerBets, useTreasuryBalances } from "./api/metrics";
import {
  BPS,
  deriveRolls,
  fetchJackpotCap,
  fetchPendingSpin,
  fetchTableConfigByIndex,
  fetchJackpotState,
  fetchJackpotTiers,
  fetchJackpotOutcomes,
  findSeed,
  parseWager,
  previewSpin,
  type SpinPreview,
  toAddressOrZero,
  useApproveHandler,
  useFulfillRandomness,
  useHardhatAccounts,
  useJackpotState,
  useJackpotTiers,
  useJackpotOutcomes,
  useDirectBetOutcomes,
  useReferralTree,
  useReferralContributions,
  useStartSpin,
  useTableConfig,
} from "./api/operations";
import { getAddress } from "viem";
import { MetricCard } from "./components/MetricCard";
import { formatEVA, formatDateTime } from "./utils/format";
import { useEffect, useState } from "react";

const queryClient = new QueryClient();

function DashboardMetrics() {
  const { data, isLoading, error } = useMetrics();

  if (isLoading) return <div>Loading metrics…</div>;
  if (error || !data) return <div className="text-red-600">Failed to load metrics.</div>;

  return (
    <div className="metrics-grid">
      <MetricCard label="Total Bets" value={data.totalBets.toLocaleString()} hint="Resolved and pending bets" />
      <MetricCard
        label="Total Wager"
        value={`${formatEVA(data.totalWager, { compact: true })} EVA`}
        hint="Aggregate wagered amount"
      />
      <MetricCard
        label="Total Payout"
        value={`${formatEVA(data.totalPayout, { compact: true })} EVA`}
        hint="Multiplier payouts"
      />
      <MetricCard
        label="Total Jackpot Payout"
        value={`${formatEVA(data.totalJackpotPayout, { compact: true })} EVA`}
      />
      <MetricCard label="House Fee" value={`${formatEVA(data.houseFee, { compact: true })} EVA`} />
      <MetricCard label="Referral Fee" value={`${formatEVA(data.referralFee, { compact: true })} EVA`} />
      <MetricCard label="House Net" value={`${formatEVA(data.houseNet, { compact: true })} EVA`} />
      <MetricCard label="Average Wager" value={`${data.avgWager.toFixed(2)} EVA`} />
      <MetricCard label="Average Multiplier" value={`${data.avgMultiplier.toFixed(2)}x`} />
    </div>
  );
}

function TreasuryBalancesSection() {
  const { data, isLoading, error } = useTreasuryBalances();

  if (isLoading) return <div>Loading treasury balances…</div>;
  if (error || !data) return <div className="text-red-600">Failed to load treasury balances.</div>;

  return (
    <div className="treasury-grid">
      <MetricCard
        label="Roulette Liquidity"
        value={`${formatEVA(data.roulette, { compact: true })} EVA`}
        hint="EVA held by roulette contract"
      />
      <MetricCard
        label="Jackpot Pool"
        value={`${formatEVA(data.jackpot, { compact: true })} EVA`}
        hint="Progressive jackpot balance"
      />
      <MetricCard
        label="Payment Handler"
        value={`${formatEVA(data.handler, { compact: true })} EVA`}
        hint="Instant bet buffer"
      />
      <MetricCard
        label="House Wallet"
        value={`${formatEVA(data.house, { compact: true })} EVA`}
        hint="House fee recipient"
      />
      <MetricCard
        label="Referral Treasury"
        value={`${formatEVA(data.referral, { compact: true })} EVA`}
        hint="Referral rewards contract"
      />
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <main className="app">
        <div className="container">
          <header className="header">
            <h1>Burning Games Admin Dashboard</h1>
            <p>Live overview of roulette performance and balances.</p>
          </header>

          <section>
            <h2>Global Metrics</h2>
            <DashboardMetrics />
          </section>

          <section>
            <h2>Treasury Balances</h2>
            <TreasuryBalancesSection />
          </section>

          <section>
            <h2>Roulette Controls</h2>
            <OperationsPanel />
          </section>

          <section className="players-section">
            <h2>Players</h2>
            <PlayersView />
          </section>
        </div>
      </main>
    </QueryClientProvider>
  );
}

const toBig = (value: unknown): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.length > 0) return BigInt(value);
  return 0n;
};

function OperationsPanel() {
  const [selectedAccount, setSelectedAccount] = useState<string>("");
  const [referrer, setReferrer] = useState<string>("");
  const [wager, setWager] = useState<string>("1.0");
  const [multiplier, setMultiplier] = useState<number>(150);
  const [previewWager, setPreviewWager] = useState<string>("1.0");
  const [requestId, setRequestId] = useState<string>("");
  const [randomWord, setRandomWord] = useState<string>("");
  const [derivedRolls, setDerivedRolls] = useState<bigint[] | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [previewConfigIndex, setPreviewConfigIndex] = useState<number>(-1);
  const [previewResult, setPreviewResult] = useState<SpinPreview | null>(null);
  const bpsAsNumber = Number(BPS);

  const accountsQuery = useHardhatAccounts();
  const tableConfigQuery = useTableConfig();
  const jackpotStateQuery = useJackpotState();
  const jackpotTiersQuery = useJackpotTiers();
  const jackpotOutcomesQuery = useJackpotOutcomes();
  const directBetOutcomesQuery = useDirectBetOutcomes();
  const approveHandler = useApproveHandler();
  const startSpin = useStartSpin();
  const fulfillRandomness = useFulfillRandomness();

  const accounts = accountsQuery.data ?? [];
  const config = tableConfigQuery.data?.config;
  const scaling = tableConfigQuery.data?.scaling;

  useEffect(() => {
    if (!selectedAccount && accounts.length > 0) {
      setSelectedAccount(accounts[0]);
    }
  }, [accounts, selectedAccount]);

  const handleApprove = async () => {
    try {
      if (!selectedAccount) throw new Error("Select a wallet to approve");
      const account = getAddress(selectedAccount);
      await approveHandler.mutateAsync({ account, amount: (1n << 256n) - 1n });
      setStatusMessage(`Approval submitted from ${account}`);
    } catch (error) {
      console.error("approve handler error", error);
      alert(`Failed to approve handler: ${error}`);
    }
  };

  const handleStart = async () => {
    try {
      if (!selectedAccount) throw new Error("Select a wallet to start a spin");
      const account = getAddress(selectedAccount);
      const ref = referrer.trim() ? getAddress(referrer as `0x${string}`) : toAddressOrZero(referrer);
      const previewAmount = parseWager(previewWager);
      const boundedMultiplier = Math.max(1, Math.min(65535, Number(multiplier)));
      const multiplierHundredths = BigInt(boundedMultiplier);
      const wagerAmount = parseWager(wager);
      const result = await startSpin.mutateAsync({
        account,
        wager: wagerAmount,
        multiplier: multiplierHundredths,
        referrer: ref,
      });
      if (result.requestId) {
        setRequestId(result.requestId);
        setStatusMessage(`Spin started (requestId ${result.requestId})`);
        setDerivedRolls(null);
      } else {
        setStatusMessage(`Spin started. Tx hash ${result.hash}`);
      }
    } catch (error) {
      console.error("start spin error", error);
      alert(`Failed to start spin: ${error}`);
    }
  };

  const handleFulfill = async () => {
    try {
      if (!selectedAccount) throw new Error("Select a wallet to fulfill");
      const account = getAddress(selectedAccount);
      if (!requestId.trim()) throw new Error("Request id required");
      const idString = requestId.trim();
      const id = BigInt(idString.startsWith("0x") ? idString : idString);
      const wordInput = randomWord.trim();
      const word = wordInput ? BigInt(wordInput.startsWith("0x") ? wordInput : wordInput) : undefined;
      const { randomWord: usedWord } = await fulfillRandomness.mutateAsync({
        account,
        requestId: id,
        randomWord: word,
      });
      setStatusMessage(`Fulfilled request ${id.toString()} with random word ${usedWord.toString()}`);
    } catch (error) {
      console.error("fulfill randomness error", error);
      alert(`Failed to fulfill randomness: ${error}`);
    }
  };

  const handlePreviewRolls = async () => {
    try {
      if (!randomWord.trim()) {
        throw new Error("Enter a random word to preview");
      }
      const seedBigInt = BigInt(randomWord.trim().startsWith("0x") ? randomWord.trim() : randomWord.trim());
      const rolls = deriveRolls(seedBigInt, 10_000n);
      setDerivedRolls(rolls);
      setStatusMessage(`Previewed rolls for seed ${seedBigInt.toString()}`);
    } catch (error) {
      console.error("preview rolls error", error);
      alert(`Failed to preview rolls: ${error}`);
    }
  };

  const replayBpsConfig = toBig(config?.replayBps ?? 0);

  const handleSpinPreview = async () => {
    try {
      const previewAmount = parseWager(previewWager);
      const multiplierHundredths = BigInt(Math.max(1, Math.min(65535, Number(multiplier))));
      const configIndex = Number.isInteger(previewConfigIndex) ? previewConfigIndex : -1;
      const result = await previewSpin(previewAmount, multiplierHundredths, configIndex);
      setPreviewResult(result);
      setStatusMessage(
        `Preview multiplier=${result.multiplierBps} bps, replay=${result.replayBps} bps, jackpot entry=${result.jackpotBps} bps`,
      );
    } catch (error) {
      console.error("spin preview error", error);
      alert(`Failed to preview spin: ${error}`);
    }
  };

  const handleForceLose = async () => {
    try {
      if (!requestId.trim()) throw new Error("Request id required");
      const req = BigInt(requestId);
      const pending = await fetchPendingSpin(req);
      const { config: tableConfig } = await fetchTableConfigByIndex(pending.configIndex ?? 0);
      const multiplierBps = pending.multiplierBps ?? 0n;
      const replayBps = BigInt(tableConfig.replayBps ?? 0);
      const jackpotBps = pending.jackpotBps ?? 0n;
      const loseThreshold = multiplierBps + replayBps + jackpotBps;
      console.log("forceLose thresholds", {
        multiplierBps: multiplierBps.toString(),
        replayBps: replayBps.toString(),
        jackpotBps: jackpotBps.toString(),
        loseThreshold: loseThreshold.toString(),
      });
      const seed = findSeed((rolls) => rolls[0] >= loseThreshold && rolls[0] < BPS, 0n);
      console.log("forceLose seed", { seed: seed.toString() });
      setRandomWord(seed.toString());
      setDerivedRolls(deriveRolls(seed, 0n));
    } catch (error) {
      console.error("force lose error", error);
      alert(`Failed to compute seed: ${error}`);
    }
  };

  const handleForceMultiplier = async () => {
    try {
      if (!requestId.trim()) throw new Error("Request id required");
      const req = BigInt(requestId);
      const pending = await fetchPendingSpin(req);
      const multiplierBps = pending.multiplierBps ?? 0n;
      console.log("forceMultiplier threshold", { multiplierBps: multiplierBps.toString() });
      const seed = findSeed((rolls) => rolls[0] < multiplierBps, 0n);
      console.log("forceMultiplier seed", { seed: seed.toString() });
      setRandomWord(seed.toString());
      setDerivedRolls(deriveRolls(seed, 0n));
    } catch (error) {
      console.error("force multiplier error", error);
      alert(`Failed to compute seed: ${error}`);
    }
  };

  const handleForceReplay = async () => {
    try {
      if (!requestId.trim()) throw new Error("Request id required");
      const req = BigInt(requestId);
      const pending = await fetchPendingSpin(req);
      const { config: tableConfig } = await fetchTableConfigByIndex(pending.configIndex ?? 0);
      const multiplierBps = pending.multiplierBps ?? 0n;
      const replayBps = BigInt(tableConfig.replayBps ?? 0);
      const jackpotCap = await fetchJackpotCap();
      console.log("forceReplay thresholds", {
        multiplierBps: multiplierBps.toString(),
        replayBps: replayBps.toString(),
        jackpotCap: jackpotCap.toString(),
      });
      const seed = findSeed(
        (rolls) => {
          console.log({multiplierBps, replayBps, rolls})
          return rolls[0] >= multiplierBps && rolls[0] < multiplierBps + replayBps;
        },
        jackpotCap
      );
      console.log("forceReplay seed", { seed: seed.toString() });
      setRandomWord(seed.toString());
      setDerivedRolls(deriveRolls(seed, jackpotCap));
    } catch (error) {
      console.error("force replay error", error);
      alert(`Failed to compute seed: ${error}`);
    }
  };
  const forceReplays = async (replayCount: number) => {
    if (!requestId.trim()) throw new Error("Request id required");
    if (replayCount < 2 || replayCount > 5) throw new Error("Replay count must be 2..5");
  
    const req = BigInt(requestId);
    const pending = await fetchPendingSpin(req);
    const { config: tableConfig } = await fetchTableConfigByIndex(pending.configIndex ?? 0);
  
    const multiplierBps = pending.multiplierBps ?? 0n;
    const replayBps = BigInt(tableConfig.replayBps ?? 0);
    if (replayBps === 0n) throw new Error("Replay BPS is zero; cannot force replay");
    if (multiplierBps === 0n) throw new Error("Multiplier BPS is zero; cannot end on multiplier after replays");
  
    // We don't need jackpot roll for pure replay flow
    const cap = 0n;
  
    // Require: for i=0..(replayCount-1): replay slice
    // Then for i=replayCount: multiplier slice (end on multiplier)
    const seed = findSeed(
      (rolls) => {
        // Guard: ensure we have enough base rolls
        if (rolls.length < replayCount + 1) return false;
  
        for (let i = 0; i < replayCount; i++) {
          const r = rolls[i];
          const isReplay = r >= multiplierBps && r < multiplierBps + replayBps;
          if (!isReplay) return false;
        }
  
        const end = rolls[replayCount];
        const isMultiplier = end < multiplierBps;
        return isMultiplier;
      },
      cap
    );
  
    setRandomWord(seed.toString());
    setDerivedRolls(deriveRolls(seed, cap));
    setStatusMessage(`Seed computed for ${replayCount} replay(s) then multiplier`);
  };
  const handleForce2Replays = async () => {
    try { await forceReplays(2); } catch (e) { alert(`Failed to compute seed: ${e}`); }
  };
  const handleForce3Replays = async () => {
    try { await forceReplays(3); } catch (e) { alert(`Failed to compute seed: ${e}`); }
  };
  const handleForce4Replays = async () => {
    try { await forceReplays(4); } catch (e) { alert(`Failed to compute seed: ${e}`); }
  };
  const handleForce5Replays = async () => {
    try { await forceReplays(5); } catch (e) { alert(`Failed to compute seed: ${e}`); }
  };
  const handleForceJackpot = async () => {
    try {
      if (!requestId.trim()) throw new Error("Request id required");
      const req = BigInt(requestId);
      const pending = await fetchPendingSpin(req);
      const { config: tableConfig } = await fetchTableConfigByIndex(pending.configIndex ?? 0);
      const replayBps = BigInt(tableConfig.replayBps ?? 0);
      const multiplierBps = pending.multiplierBps ?? 0n;
      const jackpotBps = pending.jackpotBps ?? 0n;
      const jackpotCap = await fetchJackpotCap();
      console.log("forceJackpot thresholds", {
        multiplierBps: multiplierBps.toString(),
        replayBps: replayBps.toString(),
        jackpotBps: jackpotBps.toString(),
        jackpotCap: jackpotCap.toString(),
      });
      const seed = findSeed(
        (rolls) =>
          rolls[0] >= multiplierBps + replayBps &&
          rolls[0] < multiplierBps + replayBps + jackpotBps,
        jackpotCap
      );
      console.log("forceJackpot seed", { seed: seed.toString() });
      setRandomWord(seed.toString());
      setDerivedRolls(deriveRolls(seed, jackpotCap));
    } catch (error) {
      console.error("force jackpot error", error);
      alert(`Failed to compute seed: ${error}`);
    }
  };
  async function selectJackpotSlice(target: { kind: "TIER" | "CONSOLATION" | "LOSE"; multiplierBps?: number }) {
    const outcomes = await fetchJackpotOutcomes(); // returns cumulativeProbability, consolationMultiplier, awardsTier
    if (!outcomes || outcomes.length === 0) throw new Error("No jackpot outcomes configured");
  
    let prev = 0;
    const slices = outcomes.map((o) => {
      const end = o.cumulativeProbability;        // cumulative bps (0..10000)
      const start = prev;
      prev = end;
      const kind = o.awardsTier ? "TIER" : o.consolationMultiplier > 0 ? "CONSOLATION" : "LOSE";
      return {
        start,                     // inclusive (bps)
        end,                       // exclusive (bps)
        kind,
        consolationMultiplier: o.consolationMultiplier, // in bps (e.g., 1200, 1500)
      };
    });
  
    if (target.kind === "CONSOLATION" && target.multiplierBps != null) {
      const s = slices.find((s) => s.kind === "CONSOLATION" && s.consolationMultiplier === target.multiplierBps);
      if (!s) throw new Error(`Consolation slice ${target.multiplierBps} bps not found`);
      return s;
    }
  
    const s = slices.find((s) => s.kind === target.kind);
    if (!s) throw new Error(`No ${target.kind} slice found`);
    return s;
  }
  
  const handleForceJackpotTier = async () => {
    try {
      if (!requestId.trim()) throw new Error("Request id required");
      const req = BigInt(requestId);
      const pending = await fetchPendingSpin(req);
      const { config: tableConfig } = await fetchTableConfigByIndex(pending.configIndex ?? 0);
  
      const multiplierBps = pending.multiplierBps ?? 0n;
      const replayBps = BigInt(tableConfig.replayBps ?? 0);
      const jackpotBps = pending.jackpotBps ?? 0n;
      const cap = await fetchJackpotCap();
  
      const slice = await selectJackpotSlice({ kind: "TIER" });
  
      const seed = findSeed(
        (rolls) => {
          const baseOk =
            rolls[0] >= multiplierBps + replayBps &&
            rolls[0] <  multiplierBps + replayBps + jackpotBps;
          const jr = rolls[6];
          const jpOk = jr < cap && jr >= BigInt(slice.start) && jr < BigInt(slice.end);
          return baseOk && jpOk;
        },
        cap
      );
  
      setRandomWord(seed.toString());
      setDerivedRolls(deriveRolls(seed, cap));
      setStatusMessage(`Seed for Jackpot → Tier slice [${slice.start}, ${slice.end})`);
    } catch (e) {
      alert(`Failed to compute seed: ${e}`);
    }
  };
  
  const handleForceJackpotConsolation1200 = async () => {
    try {
      if (!requestId.trim()) throw new Error("Request id required");
      const req = BigInt(requestId);
      const pending = await fetchPendingSpin(req);
      const { config: tableConfig } = await fetchTableConfigByIndex(pending.configIndex ?? 0);
  
      const multiplierBps = pending.multiplierBps ?? 0n;
      const replayBps = BigInt(tableConfig.replayBps ?? 0);
      const jackpotBps = pending.jackpotBps ?? 0n;
      const cap = await fetchJackpotCap();
  
      const slice = await selectJackpotSlice({ kind: "CONSOLATION", multiplierBps: 1200 });
  
      const seed = findSeed(
        (rolls) => {
          const baseOk =
            rolls[0] >= multiplierBps + replayBps &&
            rolls[0] <  multiplierBps + replayBps + jackpotBps;
          const jr = rolls[6];
          const jpOk = jr < cap && jr >= BigInt(slice.start) && jr < BigInt(slice.end);
          return baseOk && jpOk;
        },
        cap
      );
  
      setRandomWord(seed.toString());
      setDerivedRolls(deriveRolls(seed, cap));
      setStatusMessage(`Seed for Jackpot → Consolation (1.20x) slice [${slice.start}, ${slice.end})`);
    } catch (e) {
      alert(`Failed to compute seed: ${e}`);
    }
  };
  
  const handleForceJackpotConsolation1500 = async () => {
    try {
      if (!requestId.trim()) throw new Error("Request id required");
      const req = BigInt(requestId);
      const pending = await fetchPendingSpin(req);
      const { config: tableConfig } = await fetchTableConfigByIndex(pending.configIndex ?? 0);
  
      const multiplierBps = pending.multiplierBps ?? 0n;
      const replayBps = BigInt(tableConfig.replayBps ?? 0);
      const jackpotBps = pending.jackpotBps ?? 0n;
      const cap = await fetchJackpotCap();
  
      const slice = await selectJackpotSlice({ kind: "CONSOLATION", multiplierBps: 1500 });
  
      const seed = findSeed(
        (rolls) => {
          const baseOk =
            rolls[0] >= multiplierBps + replayBps &&
            rolls[0] <  multiplierBps + replayBps + jackpotBps;
          const jr = rolls[6];
          const jpOk = jr < cap && jr >= BigInt(slice.start) && jr < BigInt(slice.end);
          return baseOk && jpOk;
        },
        cap
      );
  
      setRandomWord(seed.toString());
      setDerivedRolls(deriveRolls(seed, cap));
      setStatusMessage(`Seed for Jackpot → Consolation (1.50x) slice [${slice.start}, ${slice.end})`);
    } catch (e) {
      alert(`Failed to compute seed: ${e}`);
    }
  };
  
  const handleForceJackpotLose = async () => {
    try {
      if (!requestId.trim()) throw new Error("Request id required");
      const req = BigInt(requestId);
      const pending = await fetchPendingSpin(req);
      const { config: tableConfig } = await fetchTableConfigByIndex(pending.configIndex ?? 0);
  
      const multiplierBps = pending.multiplierBps ?? 0n;
      const replayBps = BigInt(tableConfig.replayBps ?? 0);
      const jackpotBps = pending.jackpotBps ?? 0n;
      const cap = await fetchJackpotCap();
  
      const slice = await selectJackpotSlice({ kind: "LOSE" });
  
      const seed = findSeed(
        (rolls) => {
          const baseOk =
            rolls[0] >= multiplierBps + replayBps &&
            rolls[0] <  multiplierBps + replayBps + jackpotBps;
          const jr = rolls[6];
          const jpOk = jr < cap && jr >= BigInt(slice.start) && jr < BigInt(slice.end);
          return baseOk && jpOk;
        },
        cap
      );
  
      setRandomWord(seed.toString());
      setDerivedRolls(deriveRolls(seed, cap));
      setStatusMessage(`Seed for Jackpot → Lose slice [${slice.start}, ${slice.end})`);
    } catch (e) {
      alert(`Failed to compute seed: ${e}`);
    }
  };
  const formatTierPrize = (tier: { prizeMetric: bigint; isPercent: boolean }) => {
    if (tier.isPercent) {
      return `${Number(tier.prizeMetric) / 100}% of balance`;
    }
    return `${formatEVA(tier.prizeMetric.toString())} EVA`;
  };

  return (
    <>
      <div className="operations-card">
        <div className="operations-grid">
          <div>
            <h3>Start Spin</h3>
            <div className="form-grid">
              <label>
                <span>Wallet</span>
                <select value={selectedAccount} onChange={(e) => setSelectedAccount(e.target.value)}>
                  {accounts.map((address) => (
                    <option key={address} value={address}>
                      {address}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Wager (EVA)</span>
                <input value={wager} onChange={(e) => setWager(e.target.value)} placeholder="1.0" />
              </label>
              <label>
                <span>Multiplier (hundredths)</span>
                <input
                  type="number"
                  value={multiplier}
                  onChange={(e) => setMultiplier(Number(e.target.value))}
                  min={config?.minMultiplier ?? 100}
                  max={config?.maxMultiplier ?? 1000}
                />
              </label>
              <label>
                <span>Referrer (optional)</span>
                <input value={referrer} onChange={(e) => setReferrer(e.target.value)} placeholder="0x..." />
              </label>
            </div>
            <div className="operations-actions">
              <button onClick={handleApprove} disabled={approveHandler.isPending || !selectedAccount}>
                {approveHandler.isPending ? "Approving…" : "Approve Handler"}
              </button>
              <button onClick={handleStart} disabled={startSpin.isPending || !selectedAccount}>
                {startSpin.isPending ? "Starting…" : "Start Spin"}
              </button>
            </div>

            <div className="preview-spin">
              <h4>Spin Preview Probabilities</h4>
              <div className="form-grid">
                <label>
                  <span>Config Index (blank = current)</span>
                  <input
                    type="number"
                    placeholder="Current"
                    value={previewConfigIndex < 0 ? "" : previewConfigIndex}
                    onChange={(event) =>
                      setPreviewConfigIndex(event.target.value === "" ? -1 : Number(event.target.value))
                    }
                    min={0}
                  />
                </label>
              <label>
                <span>Wager (EVA)</span>
                <input
                  value={previewWager}
                  onChange={(event) => setPreviewWager(event.target.value)}
                  placeholder="1.0"
                />
              </label>
              </div>
              <div className="operations-actions">
                <button type="button" onClick={handleSpinPreview}>
                  Preview Spin Chances
                </button>
              </div>
              {previewResult && (
                <div className="preview-results">
                  <ul>
                    <li>
                      Multiplier Chance: {((previewResult.multiplierBps ?? 0) * 100 / bpsAsNumber).toFixed(2)}% ({
                        previewResult.multiplierBps
                      } bps)
                    </li>
                    <li>
                      Replay Chance (extra spin): {((previewResult.replayBps ?? 0) * 100 / bpsAsNumber).toFixed(2)}% ({
                        previewResult.replayBps
                      } bps)
                    </li>
                    <li>
                      Jackpot Entry Chance: {((previewResult.jackpotBps ?? 0) * 100 / bpsAsNumber).toFixed(2)}% ({
                        previewResult.jackpotBps
                      } bps)
                    </li>
                    <li>
                      Lose Chance: {((previewResult.loseBps ?? 0) * 100 / bpsAsNumber).toFixed(2)}% ({
                        previewResult.loseBps
                      } bps)
                    </li>
                    <li>Max Payout (on multiplier win): {formatEVA(previewResult.maxPayout.toString())} EVA</li>
                    <li>Jackpot Contribution (per spin): {formatEVA(previewResult.jackpotContribution.toString())} EVA</li>
                  </ul>
                </div>
              )}
            </div>
            {config && (
              <p className="hint">
                Min wager: {formatEVA(config.minWager.toString())} EVA · Max multiplier: {config.maxMultiplier}
              </p>
            )}
            {statusMessage && <p className="hint status-message">{statusMessage}</p>}
          </div>

          <div>
            <h3>Fulfill Randomness</h3>
            <div className="form-grid">
              <label>
                <span>Request ID</span>
                <input value={requestId} onChange={(e) => setRequestId(e.target.value)} placeholder="e.g. 123" />
              </label>
              <label>
                <span>Random Word (optional)</span>
                <input value={randomWord} onChange={(e) => setRandomWord(e.target.value)} placeholder="Auto if empty" />
              </label>
            </div>
            <div className="operations-actions">
              <button onClick={handleFulfill} disabled={fulfillRandomness.isPending || !selectedAccount}>
                {fulfillRandomness.isPending ? "Fulfilling…" : "Fulfill Spin"}
              </button>
              <button type="button" onClick={handlePreviewRolls}>
                Preview Rolls
              </button>
            </div>
            <div className="button-row">
              <button type="button" onClick={handleForceLose}>Seed: Lose</button>
              <button type="button" onClick={handleForceMultiplier}>Seed: Multiplier</button>
              <button type="button" onClick={handleForceReplay}>Seed: Replay</button>
              <button type="button" onClick={handleForce2Replays}>Seed: 2 Replays</button>
              <button type="button" onClick={handleForce3Replays}>Seed: 3 Replays</button>
              <button type="button" onClick={handleForce4Replays}>Seed: 4 Replays</button>
              <button type="button" onClick={handleForce5Replays}>Seed: 5 Replays</button>
              <button type="button" onClick={handleForceJackpotTier}>Seed: Jackpot (Tier)</button>
              <button type="button" onClick={handleForceJackpotConsolation1200}>Seed: Jackpot (Cons 1.20x)</button>
              <button type="button" onClick={handleForceJackpotConsolation1500}>Seed: Jackpot (Cons 1.50x)</button>
              <button type="button" onClick={handleForceJackpotLose}>Seed: Jackpot (Lose)</button>
            </div>
            {derivedRolls && (
              <div className="derived-rolls">
                <div>Derived Rolls: {derivedRolls.map((value) => value.toString()).join(", ")}</div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="operations-card table-config-summary">
        <h4>Current Table Config</h4>
        {tableConfigQuery.isLoading ? (
          <p>Loading table configuration…</p>
        ) : tableConfigQuery.error || !config ? (
          <p className="text-red-600">Failed to load table configuration.</p>
        ) : (
          <>
            <ul>
              <li>Replay BPS: {config.replayBps}</li>
              <li>Jackpot BPS: {config.jackpotBps}</li>
              <li>Jackpot Contribution BPS: {config.jackpotContributionBps}</li>
              <li>Min Multiplier (hundredths): {config.minMultiplier}</li>
              <li>Max Multiplier (hundredths): {config.maxMultiplier}</li>
              <li>Min Wager: {formatEVA(config.minWager.toString())} EVA</li>
              <li>
                Max Wager: {config.maxWager === 0n ? "Unlimited" : `${formatEVA(config.maxWager.toString())} EVA`}
              </li>
            </ul>
            {scaling && (
              <div className="scaling-summary">
                <h5>Jackpot Scaling</h5>
                <ul>
                  <li>Status: {scaling.enabled ? "Enabled" : "Disabled"}</li>
                  <li>Curve: {scaling.functionName}</li>
                  <li>
                    Jackpot BPS Range: {scaling.minJackpotBps} → {scaling.maxJackpotBps}
                  </li>
                  <li>
                    Eligible Wager Range: {formatEVA(scaling.minJackpotWager.toString())} → {formatEVA(
                      scaling.maxJackpotWager.toString(),
                    )} EVA
                  </li>
                </ul>
              </div>
            )}
          </>
        )}
      </div>
      <div className="operations-card jackpot-summary">
        <h4>Jackpot Status</h4>
        {jackpotStateQuery.isLoading ? (
          <p>Loading jackpot state…</p>
        ) : jackpotStateQuery.error ? (
          <p className="text-red-600">Failed to fetch jackpot state.</p>
        ) : !jackpotStateQuery.data ? (
          <p>No jackpot configured for this deployment.</p>
        ) : (
          <ul>
            <li>Next Tier Index: {jackpotStateQuery.data.nextTierIndex}</li>
            <li>Total Entries: {jackpotStateQuery.data.totalEntries.toString()}</li>
            <li>Total Jackpots Won: {jackpotStateQuery.data.totalJackpotsWon.toString()}</li>
            <li>
              Total Consolation Paid: {formatEVA(jackpotStateQuery.data.totalConsolationPaid.toString())} EVA
            </li>
            <li>Last Winner: {jackpotStateQuery.data.lastWinner}</li>
            <li>
              Last Win (timestamp):
              {jackpotStateQuery.data.lastWinTimestamp === 0n
                ? " —"
                : ` ${new Date(Number(jackpotStateQuery.data.lastWinTimestamp) * 1000).toLocaleString()}`}
            </li>
          </ul>
        )}

        {jackpotTiersQuery.isLoading ? (
          <p>Loading tier ladder…</p>
        ) : jackpotTiersQuery.error ? (
          <p className="text-red-600">Failed to fetch tier ladder.</p>
        ) : jackpotTiersQuery.data && jackpotTiersQuery.data.length > 0 ? (
          <div className="jackpot-tiers">
            <h5>Tier Ladder</h5>
            <ol>
              {jackpotTiersQuery.data.map((tier, index) => (
                <li key={index} className={index === (jackpotStateQuery.data?.nextTierIndex ?? -1) ? "current-tier" : ""}>
                  <strong>Tier {index}</strong>: {formatTierPrize(tier)}
                  {tier.cost > 0n ? ` · Cost ${formatEVA(tier.cost.toString())} EVA` : tier.useDynamicCost ? " · Dynamic Cost" : ""}
                  {tier.isTerminal ? " · Terminal" : ""}
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <p>No tiers configured.</p>
        )}

        {jackpotOutcomesQuery.isLoading ? (
          <p>Loading jackpot outcomes…</p>
        ) : jackpotOutcomesQuery.error ? (
          <p className="text-red-600">Failed to fetch jackpot outcomes.</p>
        ) : jackpotOutcomesQuery.data && jackpotOutcomesQuery.data.length > 0 ? (
          <div className="jackpot-outcomes">
            <h5>Outcome Probabilities</h5>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Probability</th>
                  <th>Type</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {jackpotOutcomesQuery.data.map((outcome, index) => {
                  const percent = (outcome.probabilityBps / Number(BPS)) * 100;
                  const typeLabel = outcome.awardsTier
                    ? "Tier Reward"
                    : outcome.consolationMultiplier > 0
                      ? "Consolation"
                      : "Lose";
                  const detailLabel = outcome.awardsTier
                    ? `Advance ${outcome.tierAdvance}${outcome.tierAdvance === 1 ? " tier" : " tiers"} (reset to ${outcome.tierResetTo})`
                    : outcome.consolationMultiplier > 0
                      ? `${(outcome.consolationMultiplier / 100).toFixed(2)}x`
                      : "—";
                  return (
                    <tr key={index} className={outcome.awardsTier ? "jackpot-outcome-tier" : ""}>
                      <td>{index + 1}</td>
                      <td>
                        {percent.toFixed(2)}% ({outcome.probabilityBps} bps) · cumulative {outcome.cumulativeProbability}
                      </td>
                      <td>{typeLabel}</td>
                      <td>{detailLabel}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="hint">Probabilities reflect the on-chain outcome table returned by getGameOutcomes.</p>
          </div>
        ) : (
          <p>No jackpot outcomes configured.</p>
        )}

        {directBetOutcomesQuery.isLoading ? (
          <p>Loading direct bet outcomes…</p>
        ) : directBetOutcomesQuery.error ? (
          <p className="text-red-600">Failed to fetch direct bet outcomes.</p>
        ) : directBetOutcomesQuery.data && directBetOutcomesQuery.data.length > 0 ? (
          <div className="jackpot-outcomes">
            <h5>Direct Bet Outcome Probabilities</h5>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Probability</th>
                  <th>Type</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {directBetOutcomesQuery.data.map((outcome, index) => {
                  const percent = (outcome.probabilityBps / Number(BPS)) * 100;
                  const typeLabel = outcome.awardsTier
                    ? "Tier Reward"
                    : outcome.consolationMultiplier > 0
                      ? "Consolation"
                      : "Lose";
                  const detailLabel = outcome.awardsTier
                    ? `Advance ${outcome.tierAdvance}${outcome.tierAdvance === 1 ? " tier" : " tiers"} (reset to ${outcome.tierResetTo})`
                    : outcome.consolationMultiplier > 0
                      ? `${(outcome.consolationMultiplier / 100).toFixed(2)}x`
                      : "—";
                  return (
                    <tr key={index} className={outcome.awardsTier ? "jackpot-outcome-tier" : ""}>
                      <td>{index + 1}</td>
                      <td>
                        {percent.toFixed(2)}% ({outcome.probabilityBps} bps) · cumulative {outcome.cumulativeProbability}
                      </td>
                      <td>{typeLabel}</td>
                      <td>{detailLabel}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="hint">Configured via configureDirectBet on the jackpot contract.</p>
          </div>
        ) : (
          <p>No direct bet outcomes configured.</p>
        )}
      </div>
    </>
  );
}

function PlayersView() {
  const [selectedPlayer, setSelectedPlayer] = useState<string | null>(null);
  const [playersCursor, setPlayersCursor] = useState<string | undefined>(undefined);
  const {
    data: playersData,
    isLoading,
    isFetching,
    error,
  } = usePlayers(playersCursor);

  return (
    <div className="players-layout">
      <div className="players-list">
        <div className="players-list-header">
          <h3>All Players</h3>
          {isFetching && <span className="loading">Refreshing…</span>}
        </div>

        {isLoading && <div>Loading players…</div>}
        {error && <div className="error">Failed to load players.</div>}

        {playersData && (
          <>
            <table>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Bets</th>
                  <th>Total Wager</th>
                  <th>Net Result</th>
                  <th>Last Active</th>
                </tr>
              </thead>
              <tbody>
                {playersData.nodes.map((player) => {
                  const net = BigInt(player.netResult);

                  return (
                  <tr
                    key={player.address}
                    className={player.address === selectedPlayer ? "selected" : ""}
                    onClick={() => setSelectedPlayer(player.address)}
                  >
                    <td>{player.address}</td>
                    <td>{player.totalBets}</td>
                    <td>{formatEVA(player.totalWager)}</td>
                      <td className={net < 0n ? "negative" : net > 0n ? "positive" : ""}>
                        {formatEVA(player.netResult)}
                      </td>
                    <td>{player.lastActive ? formatDateTime(player.lastActive) : "—"}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="pagination-controls">
              <button
                onClick={() => setPlayersCursor(undefined)}
                disabled={!playersCursor && !playersData.nextCursor}
              >
                Reset
              </button>
              <button
                onClick={() => setPlayersCursor(playersData.nextCursor ?? undefined)}
                disabled={!playersData.nextCursor}
              >
                Next
              </button>
            </div>
          </>
        )}
      </div>

      <div className="player-detail">
        {selectedPlayer ? (
          <PlayerDetail address={selectedPlayer} />
        ) : (
          <div className="empty-state">Select a player to inspect their bets.</div>
        )}
      </div>
    </div>
  );
}

function PlayerDetail({ address }: { address: string }) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [treeDepth, setTreeDepth] = useState<number>(3);
  const [contributionLimit, setContributionLimit] = useState<number>(25);
  const {
    data: betsData,
    isLoading,
    isFetching,
    error,
  } = usePlayerBets(address, cursor);
  const { data: referralTree, isLoading: treeLoading } = useReferralTree(address, treeDepth);
  const { data: referralContributions, isLoading: contributionsLoading } = useReferralContributions(
    address,
    contributionLimit,
  );

  return (
    <div>
      <div className="player-detail-header">
        <h3>Player Bets</h3>
        <span className="player-address">{address}</span>
        {isFetching && <span className="loading">Refreshing…</span>}
      </div>

      {isLoading && <div>Loading bets…</div>}
      {error && <div className="error">Failed to load bets.</div>}

      {betsData && (
        <>
          <table>
            <thead>
              <tr>
                <th>Bet ID</th>
                <th>Status</th>
                <th>Wager</th>
                <th>Net Stake</th>
                <th>Payout</th>
                <th>Jackpot</th>
                <th>Jackpot Result</th> 
                <th>Consolation</th>                    
                <th>Spins</th>
                <th>Multiplier</th>
                <th>Net Result</th>
                <th>Created</th>
                <th>Failure Reason</th>
              </tr>
            </thead>
            <tbody>
              {betsData.nodes.map((bet) => {
                const payout = bet.outcome?.payout ? BigInt(bet.outcome.payout) : 0n;
                const jackpot = bet.outcome?.jackpotPayout ? BigInt(bet.outcome.jackpotPayout) : 0n;
                const netStake = BigInt(bet.netStake ?? bet.wager ?? "0");
                const netResult = bet.outcome?.netResult
                  ? BigInt((bet.outcome as any).netResult)
                  : payout + jackpot - netStake;

                return (
                  <tr key={bet.id}>
                    <td>{bet.requestId}</td>
                    <td>{bet.status}</td>
                    <td>{formatEVA(bet.wager)}</td>
                    <td>{formatEVA(bet.netStake ?? bet.wager)}</td>
                    <td>{formatEVA(bet.outcome?.payout ?? "0")}</td>
                    <td>{formatEVA(bet.outcome?.jackpotPayout ?? "0")}</td>
                    <td>{bet.outcome?.jackpotResult ?? "—"}</td>                                              
                    <td>{bet.outcome?.jackpotConsolationMultiplier                                            
                      ? `${(Number(bet.outcome.jackpotConsolationMultiplier) / 100).toFixed(2)}x`
                      : "—"}
                    </td>
                    <td>{bet.outcome?.spinsConsumed ?? "-"}</td>
                    <td>{(bet.multiplierHundredths / 100).toFixed(2)}x</td>
                    <td className={netResult < 0n ? "negative" : netResult > 0n ? "positive" : ""}>
                      {formatEVA(netResult.toString())}
                    </td>
                    <td>{formatDateTime(bet.createdAt)}</td>
                    <td>{bet.outcome?.failureReason ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="pagination-controls">
            <button onClick={() => setCursor(undefined)} disabled={!cursor && !betsData.nextCursor}>
              Reset
            </button>
            <button onClick={() => setCursor(betsData.nextCursor ?? undefined)} disabled={!betsData.nextCursor}>
              Next
            </button>
          </div>
        </>
      )}

      <div className="referral-section">
        <div className="referral-controls">
          <label>
            <span>Tree Depth</span>
            <input
              type="number"
              min={1}
              max={10}
              value={treeDepth}
              onChange={(event) => setTreeDepth(Number(event.target.value))}
            />
          </label>
          <label>
            <span>Contribution Rows</span>
            <input
              type="number"
              min={5}
              max={200}
              value={contributionLimit}
              onChange={(event) => setContributionLimit(Number(event.target.value))}
            />
          </label>
        </div>

        <div className="referral-tree">
          <h4>Referral Tree</h4>
          {treeLoading ? (
            <p>Loading referral tree…</p>
          ) : referralTree && referralTree.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Level</th>
                  <th>Address</th>
                  <th>Referrer</th>
                </tr>
              </thead>
              <tbody>
                {referralTree.map((node) => (
                  <tr key={`${node.level}-${node.address}`} className={node.level === 0 ? "current-tier" : ""}>
                    <td>{node.level}</td>
                    <td>{node.address}</td>
                    <td>{node.referrer ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No downline found.</p>
          )}
        </div>

        <div className="referral-contributions">
          <h4>Referral Contributions</h4>
          {contributionsLoading ? (
            <p>Loading contributions…</p>
          ) : referralContributions ? (
            <div className="referral-contribution-columns">
              <div>
                <h5>As Referrer</h5>
                {referralContributions.asReferrer.length === 0 ? (
                  <p>No referral earnings</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Level</th>
                        <th>Player</th>
                        <th>Amount</th>
                        <th>Request</th>
                        <th>Tx</th>
                        <th>Timestamp</th>
                      </tr>
                    </thead>
                    <tbody>
                      {referralContributions.asReferrer.map((entry) => (
                        <tr key={entry.id}>
                          <td>{entry.level}</td>
                          <td>{entry.player}</td>
                          <td>{formatEVA(entry.amount)}</td>
                          <td>{entry.requestId}</td>
                          <td>{entry.txHash.slice(0, 10)}…</td>
                          <td>{formatDateTime(entry.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div>
                <h5>As Player (Upstream)</h5>
                {referralContributions.asPlayer.length === 0 ? (
                  <p>No contributions recorded</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Level</th>
                        <th>Referrer</th>
                        <th>Amount</th>
                        <th>Request</th>
                        <th>Tx</th>
                        <th>Timestamp</th>
                      </tr>
                    </thead>
                    <tbody>
                      {referralContributions.asPlayer.map((entry) => (
                        <tr key={entry.id}>
                          <td>{entry.level}</td>
                          <td>{entry.referrer ?? "—"}</td>
                          <td>{formatEVA(entry.amount)}</td>
                          <td>{entry.requestId}</td>
                          <td>{entry.txHash.slice(0, 10)}…</td>
                          <td>{formatDateTime(entry.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          ) : (
            <p>No referral contribution data.</p>
          )}
        </div>
      </div>
    </div>
  );
}

