import { network } from "hardhat";
import { promises as fs } from "node:fs";
import { parseEther, formatEther } from "viem";
import "dotenv/config";

type Addr = `0x${string}`;

// ─── Config ─────────────────────────────────────────────────────────────
const TOKEN = "0x45D9831d8751B2325f3DBf48db748723726e1C8c" as Addr;
const AMOUNT_PER_WALLET = parseEther("0.1"); // 0.1 EVA each

// ─── Dry run mode: set DRY_RUN=false env var to execute for real ────────
const DRY_RUN = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";

// ─── Recipients ─────────────────────────────────────────────────────────
const WALLETS: Addr[] = [
  "0xacd627fe23053add01aa9804b7d54dd61b43ab94",
  "0x40fbbe484b8ee6139af08446950b088e10b2306a",
  "0xa7580f28d5304b55594cfc1907f36d91b3d77ce5",
  "0x1e604d77963bd8a21cf1d4cb7117bf9a1316fd32",
  "0x9bf4bee5bfbebb3a4b7060dae40ca6fd49305d60",
  "0x8c8d35429f74ec245f8ef2f4fd1e551cff97d650",
  "0x931d948f347c2eb3a863b8adf53d12b536960c44",
  "0x2b382887d362ccae885a421c978c7e998d3c95a6",
  "0x3b0cc9b77dfa0b346da482b70cab774418c0fb00",
  "0x9c6648248566f60d9c212339bd03be81e2639443",
  "0x434b1afe11ab901537048e83e21b7044c1beea27",
  "0x55a7b6a2f1430109b60cd579e9430f0e3bb2a6c2",
  "0xf6a60cb525181f9a8ad76afd7e6dab663fdea845",
  "0x5cc808d8ae48e2da52bcde251a9a4a7ffb1ba010",
  "0xfdb2fabe80ce42e59c12efd16c4a8ab51a010839",
  "0xa82a22cce5c44c8ac95ab8ac78fce8dd524678b5",
  "0xdf3e18d64bc6a983f673ab319ccae4f1a57c7097",
  "0x1cbd3b2770909d4e10f157cabc84c7264073c9ec",
  "0xbcd4042de499d14e55001ccbb24a551f3b954096",
  "0xfabb0ac9d68b0b445fb7357272ff202c5651694a",
  "0x71be63f3384f5fb98995898a86b02fb2426c5788",
  "0xbda5747bfd65f08deb54cb465eb87d40e51b197e",
  "0xcd3b766ccdd6ae721141f452c550ca635964ce71",
  "0xdd2fd4581271e230360230f9337d5c0430bf44c0",
  "0x2546bcd3c84621e976d8185a91a922ae77ecec30",
  "0x8626f6940e2eb28930efb4cef49b2d1f2c9c1199",
  "0xee7f6a930b29d7350498af97f0f9672eaecbeeff",
  "0x145e2dc5c8238d1be628f87076a37d4a26a78544",
  "0xd6a098ebcc5f8bd4e174d915c54486b077a34a51",
  "0x042a63149117602129b6922ecfe3111168c2c323",
  "0xa0ec9ee47802ceb56eb58ce80f3e41630b771b04",
  "0xfd23ba756f490df10a073600d682da4da1473fe8",
  "0x33641b86dafe35235ac537149f8feb5a5bc8198d",
  "0x4d302a6c53ca49757950a24004fc546eca99583d",
  "0xf3dd6d90e7b0b3a19c00428513aed0f559550b60",
  "0x5ee14ad58471186540bb494fb0d309327bff0fde",
  "0x832e14f204d3cb19e67e1a614582357e0fae10ba",
  "0x85e28e32e0464fdd6b4cc85220c4718a2ee91d0b",
  "0x755bdee7977fd33701397f294cbe2767da4f5a04",
  "0x3c737090e5f637a4dcd29360b964f03eb09d54b2",
  "0xe43c6d8a9674c5c3f8e97bea99197a076ce64ecd",
  "0xd7e4c63331698e8d69f556f8089779f61237d59c",
  "0xa58a77762bb374d778e9503ab3ec1eb612f62dc9",
  "0xb55b122495aecc8da5aee034e93367afa833ac72",
  "0x30ee171af6a576499ff0170e59031f7744564535",
  "0x8e7fe7f66f30da63bf73e6c066d161102a398b19",
  "0xae703fd67e101942465401bebe2c7d51fbd2f2d6",
  "0x1a60fdc5eac05cb6a7f11c53fa14b0294d5ec22a",
  "0x198a3f38008bf0a6d14ac23c3e4a2832f06d1c45",
  "0x32c2c8398d9c6b2f894ae918722e05d7670e5bd1",
  "0x6109ea30a4557d42eeb405f43b38ae8e8850edcb",
  "0xc86efeb23e102b927b07073ca8bf4ad9c9e518e6",
  "0xc6ba4d001c89bac18f13ec1c0e5eb6f0c173a634",
  "0x6f889345f7d6415a928102ea5e8752ef5cbed6a2",
  "0x0b043416bd98250a21cc3d168c5f4d02280819ab",
  "0xf48eb579acd833e30afcdf43b158c567b3560076",
  "0xeaef0d634a43723f4304790538ebc14a7d5cfa0c",
  "0x392d680e32082e34707622d9e1e8c8dd9bca2eec",
  "0x1c9a993b157ed09fa09ad20104e8821296b997d1",
  "0x755BdeE7977FD33701397F294cbE2767Da4f5A04",
  "0x8689d1D8471bf5F97Efe9fdD96fa242A596D7b49",
  "0xE9FADe45E618E11bD38a73803FB84e46a0cD6c62",
];

// ─── CSV output path ────────────────────────────────────────────────────
const CSV_DIR = new URL("./deployments/", import.meta.url);
const CSV_FILE = "airdrop-results.csv";

type Result = { recipient: string; amount: string; status: string; txHash: string };

function buildCsv(rows: Result[]): string {
  const header = "recipient,amount_eva,status,tx_hash";
  const lines = rows.map(
    (r) => `${r.recipient},${r.amount},${r.status},${r.txHash}`,
  );
  return [header, ...lines].join("\n") + "\n";
}

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  // Deduplicate (case-insensitive)
  const seen = new Set<string>();
  const unique: Addr[] = [];
  for (const w of WALLETS) {
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(w);
  }

  const totalAmount = AMOUNT_PER_WALLET * BigInt(unique.length);
  const amountStr = formatEther(AMOUNT_PER_WALLET);

  console.log("══════════════════════════════════════════════════════════════");
  console.log(DRY_RUN
    ? "  EVA AIRDROP — DRY RUN (no transactions will be sent)"
    : "  EVA AIRDROP — LIVE EXECUTION");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("");
  console.log("Token:            ", TOKEN);
  console.log("Amount per wallet:", amountStr, "EVA");
  console.log("Unique wallets:   ", unique.length);
  if (unique.length !== WALLETS.length) {
    console.log("Duplicates removed:", WALLETS.length - unique.length);
  }
  console.log("Total to send:    ", formatEther(totalAmount), "EVA");
  console.log("");

  const token = await viem.getContractAt("EverValueCoin", TOKEN);
  const balance = await token.read.balanceOf([deployer.account.address]);
  const ethBalance = await publicClient.getBalance({ address: deployer.account.address });

  console.log("Deployer EVA:     ", formatEther(balance));
  console.log("Deployer ETH:     ", formatEther(ethBalance));
  console.log("");

  if (balance < totalAmount) {
    console.error("INSUFFICIENT BALANCE. Need", formatEther(totalAmount), "EVA, have", formatEther(balance));
    process.exit(1);
  }
  console.log("✓ Sufficient EVA balance");
  console.log("");

  // ─── List all recipients ──────────────────────────────────────────────
  console.log("─── RECIPIENTS ───");
  for (let i = 0; i < unique.length; i++) {
    console.log(`  ${String(i + 1).padStart(2)}. ${unique[i]}`);
  }
  console.log("");

  if (DRY_RUN) {
    // Generate dry-run CSV
    const rows: Result[] = unique.map((w) => ({
      recipient: w.toLowerCase(),
      amount: amountStr,
      status: "pending",
      txHash: "",
    }));

    await fs.mkdir(CSV_DIR, { recursive: true });
    const csvPath = new URL(CSV_FILE, CSV_DIR);
    await fs.writeFile(csvPath, buildCsv(rows));

    console.log("══════════════════════════════════════════════════════════════");
    console.log("  DRY RUN COMPLETE — no transactions sent");
    console.log("══════════════════════════════════════════════════════════════");
    console.log("  CSV saved:", csvPath.pathname);
    console.log("");
    console.log("  To execute for real:");
    console.log("  $env:DRY_RUN=\"false\"; npx hardhat run scripts/mainnet/airdrop-eva-batch.ts --network arbitrum");
    console.log("");
    return;
  }

  // ─── Execute transfers ────────────────────────────────────────────────
  console.log("─── SENDING ───");
  const rows: Result[] = [];
  let success = 0;
  let failed = 0;

  for (let i = 0; i < unique.length; i++) {
    const recipient = unique[i];
    try {
      const tx = await token.write.transfer(
        [recipient, AMOUNT_PER_WALLET],
        { account: deployer.account },
      );
      await publicClient.waitForTransactionReceipt({ hash: tx });
      success++;
      rows.push({ recipient: recipient.toLowerCase(), amount: amountStr, status: "success", txHash: tx });
      console.log(`  [${String(i + 1).padStart(2)}/${unique.length}] ✓ ${recipient}`);
    } catch (e: any) {
      failed++;
      rows.push({ recipient: recipient.toLowerCase(), amount: amountStr, status: "failed", txHash: "" });
      console.error(`  [${String(i + 1).padStart(2)}/${unique.length}] ✗ ${recipient} — ${e?.shortMessage || e?.message}`);
    }
  }

  // ─── Save CSV ─────────────────────────────────────────────────────────
  await fs.mkdir(CSV_DIR, { recursive: true });
  const csvPath = new URL(CSV_FILE, CSV_DIR);
  await fs.writeFile(csvPath, buildCsv(rows));

  console.log("");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  AIRDROP COMPLETE");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  Successful:", success);
  console.log("  Failed:    ", failed);
  console.log("  EVA sent:  ", formatEther(AMOUNT_PER_WALLET * BigInt(success)));
  console.log("  CSV saved: ", csvPath.pathname);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
