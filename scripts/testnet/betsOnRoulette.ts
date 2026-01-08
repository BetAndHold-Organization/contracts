import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther } from "viem";

type DeploymentInfo = {
  token: string;
  handler: string;
  roulette: string;
};

async function loadDeployment(): Promise<DeploymentInfo> {
  const p = new URL("./deployments/arb-sepolia.json", import.meta.url);
  return JSON.parse(await fs.readFile(p, "utf8"));
}

// Config
const TOTAL_SPINS = 10_000;
const WAGER = parseEther("1");      // 1 EVA
const MULTIPLIER = 150;             // 1.50x (hundredths)
const REFERRER = "0x0000000000000000000000000000000000000000";

// Throttle: tx per second (adjust as needed)
const TPS = 2;                      // 2 tx/s is safe with most providers
const BASE_DELAY = Math.ceil(1000 / TPS);

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const deployment = await loadDeployment();
  const conn = await network.connect();
  const viem = conn.viem;

  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const token = await viem.getContractAt("EverValueCoin", deployment.token);
  const roulette = await viem.getContractAt("SingleRandomRoulette", deployment.roulette);

  // Sanity: ensure we're on the right network (token must have code)
  const code = await publicClient.getBytecode({ address: deployment.token as `0x${string}` });
  if (!code) throw new Error(`Token not deployed at ${deployment.token} on this RPC`);

  // Approve once for the whole batch
  const required = WAGER * BigInt(TOTAL_SPINS);
  const allowance = await token.read.allowance([deployer.account.address, deployment.handler]);
  if (allowance < required) {
    console.log("Approving handler allowance for", TOTAL_SPINS, "EVA...");
    const tx = await token.write.approve([deployment.handler, required], { account: deployer.account });
    await publicClient.waitForTransactionReceipt({ hash: tx });
  }

  console.log(`Sending ${TOTAL_SPINS} spins of 1 EVA from ${deployer.account.address}...`);
  const start = Date.now();

  for (let i = 1; i <= TOTAL_SPINS; i++) {
    // Send tx (no wait-for-mining to reduce RPC)
    await roulette.write.startSpin([WAGER, MULTIPLIER, REFERRER], { account: deployer.account });

    // Pacing with small jitter to avoid burstiness and rate limits
    const jitter = Math.floor(BASE_DELAY * (Math.random() * 0.4 - 0.2)); // ±20%
    await sleep(BASE_DELAY + jitter);

    if (i % 100 === 0 || i === TOTAL_SPINS) {
      const rate = (i / Math.max(1, (Date.now() - start) / 1000)).toFixed(2);
      console.log(`Sent ${i}/${TOTAL_SPINS} | ${rate} tx/s`);
    }
  }

  console.log(`Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });