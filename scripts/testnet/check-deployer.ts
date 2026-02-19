import { network } from "hardhat";
import "dotenv/config";

async function main() {
  const conn = await network.connect();
  const viem = conn.viem;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const address = deployer.account.address;
  const balance = await publicClient.getBalance({ address });

  console.log("Network:  ", network.name);
  console.log("Deployer: ", address);
  console.log("ETH Balance:", (Number(balance) / 1e18).toFixed(6), "ETH");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
