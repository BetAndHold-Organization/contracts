type DeploymentInfo = {
  token: `0x${string}`;
  coordinator: `0x${string}`;
  randomProvider: `0x${string}`;
  handler: `0x${string}`;
  referral: `0x${string}`;
  jackpot: `0x${string}`;
  roulette: `0x${string}`;
  house: `0x${string}`;
  fallback: `0x${string}`;
  samplePlayer: `0x${string}`;
};

let cachedDeployment: DeploymentInfo | null = null;

export async function loadDeployment(network: string): Promise<DeploymentInfo> {
  if (cachedDeployment && network === "local") {
    return cachedDeployment;
  }

  const response = await fetch(`/deployments/${network}.json`);
  if (!response.ok) {
    throw new Error(`Failed to load deployment info for ${network}`);
  }
  const data = (await response.json()) as DeploymentInfo;
  if (network === "local") {
    cachedDeployment = data;
  }
  return data;
}


