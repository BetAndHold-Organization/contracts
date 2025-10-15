// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

// Common errors
error NoBalanceToWithdraw();
error UnauthorizedCaller();
error InsufficientFunds();
error SubscriptionNotSet();
error RequestNotPending();
error RequestTimedOut();
error InvalidRandomWords();

// BurningRoulette errors
error InvalidBetAmount();
error InsufficientEVABalance();
error NoWBTCReceived();
error UnauthorizedProvider();
error RequestAlreadyProcessed();
error EmptyMultipliersArray();
error InvalidBetLimits();
error InvalidSpinCount();

// RandomProvider errors
error InvalidMaxNumber();
error GameNotEnabled();
error ProbabilityTooHigh();
error InvalidRequestId();
error OnlyGameCanClaim();
error AlreadyClaimed();
error ReservationExpired();
error InsufficientBalance();
error NotExpiredYet();
error ExceedsMaxRanges();