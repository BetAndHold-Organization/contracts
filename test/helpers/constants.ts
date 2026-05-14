/**
 * Shared test constants.
 */

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export const MAX_BPS = 10_000n;

/// uint8 sentinel used by MultiLevelReferral to mark fallback rewards in events
export const FALLBACK_LEVEL = 255;

/// Default referral bps tier values used in tests (40% / 30% / 20% / 10% — totals 100%)
export const DEFAULT_LEVEL_BPS_3 = [4000, 3000, 2000];

/// Standard wei amounts for tests (token has 18 decimals)
export const ONE_EVA = 10n ** 18n;
export const TEN_EVA = 10n * ONE_EVA;
export const HUNDRED_EVA = 100n * ONE_EVA;
export const ONE_THOUSAND_EVA = 1000n * ONE_EVA;
