import { useQuery } from "@tanstack/react-query";

import { graphqlClient } from "../lib/graphqlClient";
import { METRICS_QUERY, PLAYERS_QUERY, PLAYER_BETS_QUERY } from "./queries";
import { loadDeployment } from "../lib/deployments";
import { getPublicClient } from "../lib/rpcClient";
import { getAddress, parseAbi } from "viem";

const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
]);

const NETWORK = import.meta.env.VITE_NETWORK ?? "local";

type MetricsResponse = {
  metrics: {
    totalBets: number;
    totalWager: string;
    totalPayout: string;
    totalJackpotPayout: string;
    houseFee: string;
    referralFee: string;
    houseNet: string;
    avgWager: number;
    avgMultiplier: number;
  };
};

type PlayersResponse = {
  players: {
    nodes: Array<{
      address: string;
      totalBets: number;
      totalWager: string;
      totalPayout: string;
      totalJackpot: string;
      netResult: string;
      lastActive?: string | null;
      createdAt?: string | null;
    }>;
    totalCount: number;
    nextCursor?: string | null;
  };
};

type PlayerBetsResponse = {
  bets: {
    nodes: Array<{
      id: string;
      requestId: string;
      status: string;
      wager: string;
      netStake: string;
      jackpotContribution: string;
      multiplierHundredths: number;
      createdAt: string;
      outcome?: {
        outcome: string;
        payout: string;
        jackpotPayout: string;
        spinsConsumed: number;
        failureReason?: string | null;
        netResult?: string;
        jackpotResult?: string | null;
        jackpotConsolationMultiplier?: number | null;
      } | null;
    }>;
    totalCount: number;
    nextCursor?: string | null;
  };
};

type PlayersData = PlayersResponse["players"];
type PlayerBetsData = PlayerBetsResponse["bets"];

export function useMetrics() {
  return useQuery({
    queryKey: ["metrics"],
    queryFn: async () => {
      const client = graphqlClient;
      const data = await client.request<MetricsResponse>(METRICS_QUERY);
      return data.metrics;
    },
    refetchInterval: 5_000,
  });
}

export function usePlayers(cursor?: string, limit = 25) {
  return useQuery<PlayersData, Error>({
    queryKey: ["players", cursor, limit],
    queryFn: async () => {
      try {
        const response = await graphqlClient.request<PlayersResponse>(PLAYERS_QUERY, {
          cursor,
          limit,
        });
        console.debug("usePlayers fetched", response);
        return response.players;
      } catch (error) {
        console.error("usePlayers error", { cursor, limit, error });
        throw error;
      }
    },
    retry: 1,
  });
}

type TreasuryBalances = {
  roulette: string;
  jackpot: string;
  house: string;
  referral: string;
  handler: string;
};

export function useTreasuryBalances() {
  return useQuery<TreasuryBalances, Error>({
    queryKey: ["treasury-balances", NETWORK],
    queryFn: async () => {
      const [deployment, client] = await Promise.all([loadDeployment(NETWORK), Promise.resolve(getPublicClient())]);
      const token = getAddress(deployment.token);
      const addresses = {
        roulette: getAddress(deployment.roulette),
        jackpot: getAddress(deployment.jackpot),
        house: getAddress(deployment.house),
        referral: getAddress(deployment.referral),
        handler: getAddress(deployment.handler),
      };

      const [roulette, jackpot, house, referral, handler] = await Promise.all([
        client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [addresses.roulette] }),
        client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [addresses.jackpot] }),
        client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [addresses.house] }),
        client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [addresses.referral] }),
        client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [addresses.handler] }),
      ]);

      return {
        roulette: roulette.toString(),
        jackpot: jackpot.toString(),
        house: house.toString(),
        referral: referral.toString(),
        handler: handler.toString(),
      };
    },
    refetchInterval: 10_000,
  });
}

export function usePlayerBets(player: string, cursor?: string, limit = 25) {
  return useQuery<PlayerBetsData, Error>({
    queryKey: ["player-bets", player, cursor, limit],
    queryFn: async () => {
      try {
        const response = await graphqlClient.request<PlayerBetsResponse>(PLAYER_BETS_QUERY, {
          player,
          cursor,
          limit,
        });
        console.debug("usePlayerBets fetched", { player, cursor, limit, response });
        return response.bets;
      } catch (error) {
        console.error("usePlayerBets error", { player, cursor, limit, error });
        throw error;
      }
    },
    enabled: Boolean(player),
    retry: 1,
  });
}

