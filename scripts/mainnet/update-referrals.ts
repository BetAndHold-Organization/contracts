import { network } from "hardhat";
import "dotenv/config";

type Addr = `0x${string}`;

// ─── V5 Infrastructure ──────────────────────────────────────────────────
const REFERRAL = "0xf359892154589e9459c6f979d5de37a2755cf0e9" as Addr;

// ─── New ladder: 3 levels → 80% / 15% / 5% ─────────────────────────────
const NEW_LEVEL_COUNT = 3;
const NEW_LADDER = [8000, 1500, 500] as const;

// ─── Referral chain ─────────────────────────────────────────────────────
// Gabriel (Level 0) → Lisa (Level 1) → Jessica/Eva/Kauan (Level 2)
//
const GABRIEL  = "0x04af9c141fD108730ac4d8532Fdd2375Deab917C" as Addr;
const LISA     = "0xfbfd829a0acf02ac393ebe06136c17b67bc58a4c" as Addr;
const JESSICA  = "0xd5d484e5f06ec1dfd8b193340e1946bfddfa7d88" as Addr;
const EVA      = "0xc7137d1427cebe3e842b621f862a6d1afaf0afc3" as Addr;
const KAUAN    = "0xc57c06f9c154b9e13078aa5133532f204c72c982" as Addr;

// referrerOf[player] = referrer
const REFEREES  = [LISA,    JESSICA, EVA,  KAUAN] as const;
const REFERRERS = [GABRIEL, LISA,    LISA, LISA ] as const;

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const referral = await viem.getContractAt("MultiLevelReferral", REFERRAL);

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  UPDATE REFERRAL LADDER + SEED NEW REFERRALS");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("Deployer:         ", deployer.account.address);
  console.log("Referral contract:", REFERRAL);
  console.log("");

  // ─── 1. Read current ladder ───────────────────────────────────────────
  const [oldCount, oldBps] = await referral.read.getLevels();
  console.log("─── CURRENT LADDER ───");
  console.log("  Levels:", oldCount);
  for (let i = 0; i < oldCount; i++) {
    console.log(`  Level ${i + 1}: ${Number(oldBps[i]) / 100}%`);
  }
  console.log("");

  // ─── 2. Set new ladder: 3 levels [80%, 15%, 5%] ──────────────────────
  console.log("─── SETTING NEW LADDER ───");
  console.log("  3 levels: 80% / 15% / 5%");

  let tx = await referral.write.setLevels(
    [NEW_LEVEL_COUNT, NEW_LADDER],
    { account: deployer.account },
  );
  await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  TX:", tx);

  const [newCount, newBps] = await referral.read.getLevels();
  console.log("  Verified:");
  for (let i = 0; i < newCount; i++) {
    console.log(`    Level ${i + 1}: ${Number(newBps[i]) / 100}%`);
  }
  console.log("");

  // ─── 3. Seed referral chain ───────────────────────────────────────────
  console.log("─── SEEDING REFERRALS ───");
  console.log("  Gabriel:", GABRIEL);
  console.log("  Lisa:   ", LISA, "→ referred by Gabriel");
  console.log("  Jessica:", JESSICA, "→ referred by Lisa");
  console.log("  Eva:    ", EVA, "→ referred by Lisa");
  console.log("  Kauan:  ", KAUAN, "→ referred by Lisa");
  console.log("");

  tx = await referral.write.adminSetReferrers(
    [REFEREES, REFERRERS],
    { account: deployer.account },
  );
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log("  TX:", tx);
  console.log("  Block:", receipt.blockNumber, " Gas:", receipt.gasUsed.toString());
  console.log("");

  // ─── 4. Verify on-chain ───────────────────────────────────────────────
  console.log("─── VERIFICATION ───");
  for (let i = 0; i < REFEREES.length; i++) {
    const onChain = await referral.read.referrerOf([REFEREES[i]]);
    const expected = REFERRERS[i];
    const match = onChain.toLowerCase() === expected.toLowerCase();
    console.log(`  ${match ? "✓" : "✗"} referrerOf(${REFEREES[i].slice(0, 10)}...) = ${onChain.slice(0, 10)}...`);
  }

  console.log("");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  DONE");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("  Ladder:    3 levels → 80% / 15% / 5%");
  console.log("  Referrals: 4 relationships seeded");
  console.log("");
  console.log("  When Jessica bets 1 EVA (1.5% referral = 0.015 EVA):");
  console.log("    Lisa (direct):  80% → 0.012 EVA");
  console.log("    Gabriel (L2):   15% → 0.00225 EVA");
  console.log("    L3 (none):       5% → 0.00075 EVA → defaultReceiver (house)");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
