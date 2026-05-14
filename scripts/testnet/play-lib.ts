/**
 * Shared helpers for testnet play scripts.
 *
 * Centralizes the boring stuff so the play-*.ts files stay readable:
 *   - connect + load deployment + derive wallets + build wallet clients
 *   - format EVA / ETH amounts
 *   - poll for VRF settlement events (with timeout)
 *   - log section banners
 */

import { network } from "hardhat";
import {
  createWalletClient,
  decodeEventLog,
  http,
  formatEther,
  type Account,
  type Address,
  type PublicClient,
} from "viem";
import { arbitrumSepolia } from "viem/chains";

/** Wallet client with a CONCRETE account (the hardhat-viem plugin requires this). */
export type BoundWalletClient = ReturnType<typeof createWalletClient<
  ReturnType<typeof http>,
  typeof arbitrumSepolia,
  Account
>>;

import {
  loadTestnetEnv,
  deriveTestnetWallets,
  loadDeployment,
  type TestnetWallets,
  type Deployment,
  type TestnetRole,
} from "./lib.js";

type Addr = `0x${string}`;

// ── Logging helpers ────────────────────────────────────────────────────────

export function banner(s: string) {
  console.log("\n" + "═".repeat(70));
  console.log(s);
  console.log("═".repeat(70));
}
export function step(s: string) { console.log(`\n→ ${s}`); }
export function ok(s: string)   { console.log(`  ✓ ${s}`); }
export function info(s: string) { console.log(`  ${s}`); }
export function warn(s: string) { console.log(`  ⚠ ${s}`); }

export function fmtEva(amount: bigint): string {
  return `${formatEther(amount)} EVA`;
}
export function fmtEth(amount: bigint): string {
  return `${formatEther(amount)} ETH`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Shared context ─────────────────────────────────────────────────────────

export interface TestnetContext {
  conn: Awaited<ReturnType<typeof network.connect>>;
  viem: Awaited<ReturnType<typeof network.connect>>["viem"];
  publicClient: PublicClient;
  deployment: Deployment;
  wallets: TestnetWallets;
  /** Wallet clients keyed by role. sessionKey/oracleSigner/feeRecipient/defaultReceiver
   *  are derived but never used as transaction senders — they have no funding. */
  walletClients: Record<TestnetRole, BoundWalletClient>;
  /** Deployer wallet client (from hardhat config). */
  deployerClient: BoundWalletClient;
  /** RPC URL (for spinning up extra wallet clients if needed). */
  rpcUrl: string;
}

export async function loadTestnetContext(): Promise<TestnetContext> {
  const env = loadTestnetEnv();
  const conn = await network.connect();
  const viem = conn.viem;
  const networkName = conn.networkName;

  if (networkName !== "arbitrumSepolia") {
    throw new Error(`This script targets arbitrumSepolia; got "${networkName}".`);
  }

  const publicClient = await viem.getPublicClient();
  const deployment = await loadDeployment(networkName);
  const wallets = deriveTestnetWallets(env.testnetSeed);

  // Sanity: deployment must match seed
  for (const role of Object.keys(deployment.wallets) as TestnetRole[]) {
    if (deployment.wallets[role].toLowerCase() !== wallets[role].address.toLowerCase()) {
      throw new Error(
        `Wallet mismatch for ${role}: deployment has ${deployment.wallets[role]}, ` +
          `seed-derived is ${wallets[role].address}. Did TESTNET_SEED change?`,
      );
    }
  }

  const [deployerClient] = await viem.getWalletClients();

  const walletClients = {} as Record<TestnetRole, BoundWalletClient>;
  for (const role of Object.keys(wallets) as TestnetRole[]) {
    walletClients[role] = createWalletClient({
      account: wallets[role] as Account,
      chain: arbitrumSepolia,
      transport: http(env.rpcUrl),
    }) as BoundWalletClient;
  }

  return {
    conn, viem, publicClient: publicClient as unknown as PublicClient,
    deployment, wallets, walletClients,
    deployerClient: deployerClient as unknown as BoundWalletClient,
    rpcUrl: env.rpcUrl,
  };
}

// ── Simulate before submit ─────────────────────────────────────────────────

/**
 * Run `simulateContract` before submitting a write so revert reasons surface
 * synchronously (viem.writeContract does NOT simulate by default — reverts only
 * show up after mining as receipt.status='reverted', losing the error context).
 *
 * Returns the tx hash on success; on revert, throws a viem error containing the
 * decoded custom-error name + args.
 */
export async function simulateAndWrite(
  ctx: TestnetContext,
  walletClient: BoundWalletClient,
  contractName: string,
  contractAddress: Addr,
  functionName: string,
  args: readonly unknown[],
): Promise<Addr> {
  const reader = await ctx.viem.getContractAt(contractName as any, contractAddress);
  // Simulate as the wallet's account so msg.sender is correct
  await ctx.publicClient.simulateContract({
    address: contractAddress,
    abi: reader.abi,
    functionName,
    args: args as any,
    account: walletClient.account.address,
  });
  // Simulation passed — submit for real
  return walletClient.writeContract({
    address: contractAddress,
    abi: reader.abi,
    functionName,
    args: args as any,
    chain: arbitrumSepolia,
  });
}

// ── VRF settlement helpers ─────────────────────────────────────────────────

/**
 * Poll for an event matching `requestId` on `contract`. Returns the matching
 * event args, or throws after `timeoutMs`.
 *
 * `fromBlock` should be the block in which the request was submitted (or just before).
 */
export async function waitForRequestEvent<TArgs extends Record<string, any>>(
  contract: any,
  eventName: string,
  requestId: bigint,
  fromBlock: bigint,
  opts: { timeoutMs?: number; pollMs?: number; label?: string } = {},
): Promise<TArgs> {
  const timeoutMs = opts.timeoutMs ?? 180_000; // 3 minutes — Chainlink Sepolia takes ~30-60s
  const pollMs = opts.pollMs ?? 5_000;
  const label = opts.label ?? eventName;
  const start = Date.now();
  let dotCount = 0;
  process.stdout.write(`  ⏳ waiting for ${label}(${requestId.toString().slice(0, 8)}…) `);
  while (Date.now() - start < timeoutMs) {
    const events = await contract.getEvents[eventName]({}, { fromBlock });
    const match = events.find((e: any) => e.args?.requestId === requestId);
    if (match) {
      process.stdout.write(` ✓\n`);
      return match.args as TArgs;
    }
    process.stdout.write(".");
    dotCount++;
    if (dotCount >= 60) { process.stdout.write("\n  ⏳ "); dotCount = 0; }
    await sleep(pollMs);
  }
  process.stdout.write(` ✗\n`);
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}(${requestId})`);
}

/**
 * Pull-model VRF wait: polls `RandomProvider.getRawWord(requestId)` until it
 * returns a non-zero value. Used by Mines, which doesn't implement the push-style
 * IRandomConsumer.fulfillRandomness callback — RandomProvider's call into Mines
 * reverts silently, but `data.rawWord` IS stored before the try/catch, so the
 * pull path still works.
 */
export async function pollRawWord(
  ctx: TestnetContext,
  requestId: bigint,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<bigint> {
  const timeoutMs = opts.timeoutMs ?? 240_000; // 4 min
  const pollMs = opts.pollMs ?? 5_000;
  const provider = await ctx.viem.getContractAt(
    "RandomProvider", ctx.deployment.contracts.randomProvider,
  );
  const start = Date.now();
  let dots = 0;
  process.stdout.write(`  ⏳ polling getRawWord(${requestId.toString().slice(0, 8)}…) `);
  while (Date.now() - start < timeoutMs) {
    const w = await provider.read.getRawWord([requestId]);
    if (w !== 0n) {
      process.stdout.write(` ✓\n`);
      return w as bigint;
    }
    process.stdout.write(".");
    dots++;
    if (dots >= 60) { process.stdout.write("\n  ⏳ "); dots = 0; }
    await sleep(pollMs);
  }
  process.stdout.write(` ✗\n`);
  throw new Error(`Timed out polling getRawWord(${requestId})`);
}

/**
 * Helper: extract the VRF requestId from a `RandomnessRequested` log emitted by
 * RandomProvider during the given tx. Walks the receipt's logs and matches the
 * event topic from the RandomProvider's ABI.
 */
export async function extractVrfRequestId(
  ctx: TestnetContext,
  txHash: Addr,
): Promise<{ requestId: bigint; fromBlock: bigint }> {
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status === "reverted") {
    throw new Error(
      `Transaction REVERTED: ${txHash}\n` +
        `  Block: ${receipt.blockNumber}\n` +
        `  Inspect: https://sepolia.arbiscan.io/tx/${txHash}`,
    );
  }

  // Parse logs DIRECTLY from the receipt — avoids eth_getLogs indexing latency
  // that can race ahead of the receipt being available.
  const provider = await ctx.viem.getContractAt(
    "RandomProvider", ctx.deployment.contracts.randomProvider,
  );
  const providerAddrLower = ctx.deployment.contracts.randomProvider.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== providerAddrLower) continue;
    try {
      const decoded: any = decodeEventLog({
        abi: provider.abi as any,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === "RandomWordsRequested") {
        const requestId = decoded.args.requestId as bigint;
        return { requestId, fromBlock: receipt.blockNumber };
      }
    } catch {
      // Different event on the same address — skip
    }
  }
  throw new Error(
    `No RandomWordsRequested log on RandomProvider in tx ${txHash} (block ${receipt.blockNumber})`,
  );
}

// ── Convenience: print player balances ─────────────────────────────────────

export async function printPlayerBalance(ctx: TestnetContext, role: TestnetRole) {
  const addr = ctx.wallets[role].address;
  const ethBal = await ctx.publicClient.getBalance({ address: addr });
  const token = await ctx.viem.getContractAt("EverValueCoin", ctx.deployment.contracts.evaToken);
  const evaBal = await token.read.balanceOf([addr]);
  console.log(`  ${role}: ${fmtEth(ethBal)} | ${fmtEva(evaBal)}`);
}
