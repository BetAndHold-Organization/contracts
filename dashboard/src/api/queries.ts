import { gql } from "graphql-request";

export const METRICS_QUERY = gql`
  query Metrics {
    metrics {
      totalBets
      totalWager
      totalPayout
      totalJackpotPayout
      houseFee
      referralFee
      houseNet
      avgWager
      avgMultiplier
    }
  }
`;

export const PLAYERS_QUERY = gql`
  query Players($cursor: String, $limit: Int) {
    players(cursor: $cursor, limit: $limit) {
      nodes {
        address
        totalBets
        totalWager
        totalPayout
        totalJackpot
        netResult
        lastActive
        createdAt
      }
      totalCount
      nextCursor
    }
  }
`;

export const PLAYER_BETS_QUERY = gql`
  query PlayerBets($player: String!, $cursor: String, $limit: Int) {
    bets(filter: { player: $player }, cursor: $cursor, limit: $limit) {
      nodes {
        id
        requestId
        status
        wager
        netStake
        jackpotContribution
        multiplierHundredths
        createdAt
        outcome {
          outcome
          payout
          jackpotPayout
          spinsConsumed
          failureReason
        }
      }
      totalCount
      nextCursor
    }
  }
`;

