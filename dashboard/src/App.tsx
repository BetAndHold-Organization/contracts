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
  findSeed,
  parseWager,
  toAddressOrZero,
  useApproveHandler,
  useFulfillRandomness,
  useHardhatAccounts,
  useJackpotState,
  useJackpotTiers,
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
  const [requestId, setRequestId] = useState<string>("");
  const [randomWord, setRandomWord] = useState<string>("");
  const [derivedRolls, setDerivedRolls] = useState<bigint[] | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("");

  const accountsQuery = useHardhatAccounts();
  const tableConfigQuery = useTableConfig();
  const jackpotStateQuery = useJackpotState();
  const jackpotTiersQuery = useJackpotTiers();
  const approveHandler = useApproveHandler();
  const startSpin = useStartSpin();
  const fulfillRandomness = useFulfillRandomness();

  const accounts = accountsQuery.data ?? [];

  useEffect(() => {
    if (!selectedAccount && accounts.length > 0) {
      setSelectedAccount(accounts[0]);
    }
  }, [accounts, selectedAccount]);

  const config = tableConfigQuery.data;

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
      const wagerAmount = parseWager(wager);
      const boundedMultiplier = Math.max(1, Math.min(65535, Number(multiplier)));
      const multiplierHundredths = BigInt(boundedMultiplier);
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

  const handleForceLose = async () => {
    try {
      if (!requestId.trim()) throw new Error("Request id required");
      const req = BigInt(requestId);
      const pending = await fetchPendingSpin(req);
      const table = await fetchTableConfigByIndex(pending.configIndex ?? 0);
      const multiplierBps = pending.multiplierBps ?? 0n;
      const replayBps = BigInt(table.replayBps ?? 0);
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
      const table = await fetchTableConfigByIndex(pending.configIndex ?? 0);
      const multiplierBps = pending.multiplierBps ?? 0n;
      const replayBps = BigInt(pending.replayBps ?? 0);
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

  const handleForceJackpot = async () => {
    try {
      if (!requestId.trim()) throw new Error("Request id required");
      const req = BigInt(requestId);
      const pending = await fetchPendingSpin(req);
      const table = await fetchTableConfigByIndex(pending.configIndex ?? 0);
      const replayBps = BigInt(table.replayBps ?? 0);
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
              <button type="button" onClick={handleForceJackpot}>Seed: Jackpot</button>
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
  const {
    data: betsData,
    isLoading,
    isFetching,
    error,
  } = usePlayerBets(address, cursor);

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
    </div>
  );
}

