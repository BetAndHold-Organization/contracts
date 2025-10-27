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

export const REFERRAL_TREE_QUERY = gql`
  query ReferralTree($address: String!, $depth: Int) {
    referralTree(address: $address, depth: $depth) {
      address
      referrer
      level
    }
  }
`;

export const SPIN_PREVIEW_QUERY = gql`
  query SpinPreview($wager: BigInt!, $multiplier: Int!, $configIndex: Int) {
    spinPreview(wager: $wager, multiplierHundredths: $multiplier, configIndex: $configIndex) {
      multiplierBps
      replayBps
      jackpotBps
      loseBps
      maxPayout
      jackpotContribution
    }
  }
`;

export const REFERRAL_CONTRIBUTIONS_QUERY = gql`
  query ReferralContributions($address: String!, $limit: Int) {
    referralContributions(address: $address, limit: $limit) {
      asPlayer {
        id
        player
        referrer
        level
        amount
        requestId
        txHash
        blockNumber
        createdAt
      }
      asReferrer {
        id
        player
        referrer
        level
        amount
        requestId
        txHash
        blockNumber
        createdAt
      }
    }
  }
`;

