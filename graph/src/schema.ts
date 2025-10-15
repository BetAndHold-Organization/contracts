import { makeExecutableSchema } from "@graphql-tools/schema";
import { gql } from "graphql-tag";
import { GraphQLBigInt, GraphQLDateTime } from "graphql-scalars";

import { db } from "./db.js";
import {
  fetchBets,
  fetchBetByIdentifiers,
  fetchMetrics,
  fetchPlayer,
  fetchPlayers,
  fetchReferralRewards,
  fetchReferralTree,
  fetchReferralContributions,
  fetchJackpotEvents,
} from "./services/queryService.js";

const typeDefs = gql`
  scalar DateTime
  scalar BigInt

  enum BetStatus {
    PENDING
    RESOLVED
    FAILED
  }

  enum BetOutcomeType {
    LOSE
    MULTIPLIER
    JACKPOT
  }

  type BetOutcome {
    outcome: BetOutcomeType!
    payout: BigInt!
    jackpotPayout: BigInt!
    spinsConsumed: Int!
    fulfillTx: String
    failureReason: String
    resolvedAt: DateTime!
  }

  type Bet {
    id: ID!
    requestId: String!
    player: String!
    referrer: String
    blockNumber: Int!
    txHash: String!
    wager: BigInt!
    netStake: BigInt!
    jackpotContribution: BigInt!
    multiplierHundredths: Int!
    status: BetStatus!
    outcome: BetOutcome
    createdAt: DateTime!
    updatedAt: DateTime!
    completedAt: DateTime
  }

  type PaginatedBets {
    nodes: [Bet!]!
    totalCount: Int!
    nextCursor: String
  }

  type Metrics {
    totalBets: Int!
    totalWager: BigInt!
    totalPayout: BigInt!
    totalJackpotPayout: BigInt!
    houseFee: BigInt!
    referralFee: BigInt!
    jackpotBalance: BigInt!
    rouletteBalance: BigInt!
    houseNet: BigInt!
    avgWager: Float!
    avgMultiplier: Float!
  }

  type Player {
    address: String!
    totalBets: Int!
    totalWager: BigInt!
    totalPayout: BigInt!
    totalJackpot: BigInt!
    netResult: BigInt!
    lastActive: DateTime
    createdAt: DateTime
  }

  type PaginatedPlayers {
    nodes: [Player!]!
    totalCount: Int!
    nextCursor: String
  }

  type ReferralReward {
    address: String!
    pending: BigInt!
    claimed: BigInt!
    updatedAt: DateTime!
  }

  type ReferralContribution {
    id: ID!
    player: String!
    referrer: String
    level: Int!
    amount: BigInt!
    requestId: String!
    txHash: String!
    blockNumber: Int!
    createdAt: DateTime!
  }

  type ReferralTreeNode {
    address: String!
    referrer: String
    level: Int!
  }

  type JackpotEvent {
    id: Int!
    betId: String!
    tierIndex: Int!
    payout: BigInt!
    consolationMultiplier: Float!
    createdAt: DateTime!
  }

  input BetFilter {
    status: BetStatus
    player: String
    referrer: String
    txHash: String
    minBlock: Int
    maxBlock: Int
  }

  type Query {
    health: String!
    metrics: Metrics!
    bets(filter: BetFilter, cursor: String, limit: Int = 50): PaginatedBets!
    bet(id: ID, requestId: String, txHash: String): Bet
    player(address: String!): Player
    players(cursor: String, limit: Int = 50): PaginatedPlayers!
    referralRewards: [ReferralReward!]!
    referralTree(address: String!, depth: Int = 5): [ReferralTreeNode!]!
    referralContributions(
      address: String!
      limit: Int = 50
    ): ReferralContributionSummary!
    jackpotEvents(limit: Int = 50): [JackpotEvent!]!
  }

  type ReferralContributionSummary {
    asPlayer: [ReferralContribution!]!
    asReferrer: [ReferralContribution!]!
  }
`;

const resolvers = {
  DateTime: GraphQLDateTime,
  BigInt: GraphQLBigInt,
  Query: {
    health: () => "ok",
    metrics: () => fetchMetrics(db),
    bets: (
      _parent: unknown,
      args: { filter?: any; cursor?: string; limit?: number }
    ) => fetchBets(db, args),
    bet: (
      _parent: unknown,
      args: { id?: string; requestId?: string; txHash?: string }
    ) => fetchBetByIdentifiers(db, args),
    player: (_parent: unknown, args: { address: string }) =>
      fetchPlayer(db, args.address),
    players: (_parent: unknown, args: { cursor?: string; limit?: number }) =>
      fetchPlayers(db, args),
    referralRewards: () => fetchReferralRewards(db),
    referralTree: (
      _parent: unknown,
      args: { address: string; depth?: number }
    ) => fetchReferralTree(db, args.address, args.depth ?? 5),
    referralContributions: (
      _parent: unknown,
      args: { address: string; limit?: number }
    ) => fetchReferralContributions(db, args.address, args.limit ?? 50),
    jackpotEvents: (_parent: unknown, args: { limit?: number }) =>
      fetchJackpotEvents(db, args.limit ?? 50),
  },
};

export const schema = makeExecutableSchema({ typeDefs, resolvers });
