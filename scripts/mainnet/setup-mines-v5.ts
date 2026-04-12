import { network } from "hardhat";
import "dotenv/config";

type Addr = `0x${string}`;

// ─── Deployed addresses ──────────────────────────────────────────────────────
const MINES         = "0x4f5b680d14f5aab58e6912aea11672fc044de035" as Addr;
const HANDLER       = "0xabe66fc056dd0e116b90201e487ea102fd7df1ba" as Addr;
const RANDOM        = "0x6513baa6c53a570ec899bb1504a95f160b8d7850" as Addr;
const JACKPOT       = "0xb8dbb7d52be61fc30b7f47e11ddb9af472c6a2ef" as Addr;
const HOUSE_WALLET  = "0x2132c5e539F1Da6090424644576ABB5C5aDcdbbd" as Addr;

// ─── Config ──────────────────────────────────────────────────────────────────
const HOUSE_EDGE_BPS = 150;            // 1.5% (same as roulette)
const REFERRAL_BPS   = 150;            // 1.5% (same as roulette)
const CONSUMER_RANGE_LIMIT = 1n;       // Mines only needs 1 random word

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ALLOW MINES GAME — V5 MAINNET");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Network:        ", await publicClient.getChainId());
  console.log("Deployer:       ", deployer.account.address);
  console.log("Mines contract: ", MINES);
  console.log("PaymentHandler: ", HANDLER);
  console.log("RandomProvider: ", RANDOM);
  console.log("Jackpot:        ", JACKPOT);
  console.log("");

  const handler = await viem.getContractAt("PaymentHandler", HANDLER);
  const random  = await viem.getContractAt("RandomProviderV2", RANDOM);
  const jackpot = await viem.getContractAt("ProgressiveJackpotV2", JACKPOT);

  let tx: `0x${string}`;

  // ── 1. Register Mines in PaymentHandler ──────────────────────────────────
  console.log("1. Registering Mines in PaymentHandler...");
  tx = await handler.write.registerGame(
    [MINES, MINES, HOUSE_WALLET, HOUSE_EDGE_BPS, REFERRAL_BPS],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   TX:", tx);

  tx = await handler.write.setGameStatus(
    [MINES, true],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   Mines registered & enabled in handler");
  console.log("");

  // ── 2. Register Mines as consumer in RandomProvider ──────────────────────
  console.log("2. Registering Mines as RandomProvider consumer...");
  tx = await random.write.setConsumerStatus(
    [MINES, true, CONSUMER_RANGE_LIMIT],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   TX:", tx);
  console.log("   Mines enabled as VRF consumer (rangeLimit=" + CONSUMER_RANGE_LIMIT + ")");
  console.log("");

  // ── 3. Register Mines as fund-only game in Jackpot ───────────────────────
  console.log("3. Registering Mines as fund-only game in Jackpot...");
  tx = await jackpot.write.registerFundOnlyGame(
    [MINES],
    { account: deployer.account }
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("   TX:", tx);
  console.log("   Mines can deposit to jackpot but cannot enter for prizes");
  console.log("");

  // ── Verify ───────────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  VERIFICATION");
  console.log("═══════════════════════════════════════════════════════════════");

  const gameConfig = await handler.read.getGameConfig([MINES]);
  console.log("  Handler.getGameConfig(mines):");
  console.log("    payoutTarget: ", gameConfig[0]);
  console.log("    feeCollector: ", gameConfig[1]);
  console.log("    treasury:     ", gameConfig[2]);
  console.log("    houseEdgeBps: ", Number(gameConfig[3]), "(" + (Number(gameConfig[3]) / 100) + "%)");
  console.log("    referralBps:  ", Number(gameConfig[4]), "(" + (Number(gameConfig[4]) / 100) + "%)");

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  MINES AUTHORIZATION COMPLETE");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  What was done:");
  console.log("  1. PaymentHandler: Mines registered & enabled (1.5% house, 1.5% referral)");
  console.log("  2. RandomProvider: Mines authorized as VRF consumer");
  console.log("  3. Jackpot: Mines registered as fund-only (deposits allowed, no prize entry)");
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
