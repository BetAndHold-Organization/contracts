// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

/**
 * @title CrashMathLib
 * @notice Library for computing crash points with configurable house edge
 * @dev Uses fixed-point math (1e18) for precision
 *
 * ## Crash Distribution
 * The crash point distribution ensures the house edge is achieved over time.
 * Given house edge `e` (e.g., 0.03 for 3%):
 *
 * P(crash >= x) = (1 - e) / x  for x >= 1
 *
 * To compute crash point from a uniform random seed [0, 2^256):
 * 1. Normalize seed to [0, 1)
 * 2. If normalized < e, crash at 1.00x (instant crash)
 * 3. Otherwise: crashPoint = (1 - e) / (1 - normalized)
 *
 * This gives the desired distribution and guarantees the house edge.
 */
library CrashMathLib {
    // ═══════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Precision for internal calculations (1e18)
    uint256 internal constant PRECISION = 1e18;

    /// @notice Basis points denominator (10000 = 100%)
    uint256 internal constant BPS_DENOMINATOR = 10000;

    /// @notice Minimum crash point (1.00x in basis points = 10000)
    uint32 internal constant MIN_CRASH_POINT = 10000;

    /// @notice Maximum reasonable crash point (100000.00x in basis points = 1_000_000_000)
    uint32 internal constant ABSOLUTE_MAX_CRASH = 1_000_000_000;

    // ═══════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════

    error InvalidHouseEdge(uint16 provided, uint16 max);
    error InvalidMaxMultiplier(uint32 provided);

    // ═══════════════════════════════════════════════════════════════════════════
    // FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * @notice Compute crash point from combined random seed
     * @dev The seed should combine VRF, server seed, and round ID for uniqueness
     * @param seed The combined random seed
     * @param houseEdgeBps House edge in basis points (e.g., 300 = 3%)
     * @param maxMultiplierBps Maximum allowed multiplier in basis points
     * @return crashPoint The crash multiplier in basis points (e.g., 15000 = 1.50x)
     */
    function computeCrashPoint(
        uint256 seed,
        uint16 houseEdgeBps,
        uint32 maxMultiplierBps
    ) internal pure returns (uint32 crashPoint) {
        // Validate inputs
        if (houseEdgeBps >= BPS_DENOMINATOR) {
            revert InvalidHouseEdge(houseEdgeBps, uint16(BPS_DENOMINATOR - 1));
        }
        if (maxMultiplierBps < MIN_CRASH_POINT) {
            revert InvalidMaxMultiplier(maxMultiplierBps);
        }

        // Normalize seed to [0, PRECISION)
        // We use modulo to get a uniform distribution
        uint256 normalizedSeed = seed % PRECISION;

        // Calculate house edge threshold in PRECISION units
        // e.g., 2% edge = 0.02 * 1e18 = 2e16
        uint256 houseEdgeThreshold = (uint256(houseEdgeBps) * PRECISION) / BPS_DENOMINATOR;

        // If normalized seed is below house edge threshold, instant crash at 1.00x
        if (normalizedSeed < houseEdgeThreshold) {
            return MIN_CRASH_POINT;
        }

        // Calculate crash point using inverse CDF
        // crashPoint = (1 - houseEdge) / (1 - normalizedSeed/PRECISION)
        //
        // In fixed point:
        // numerator = (BPS_DENOMINATOR - houseEdgeBps) * PRECISION
        // denominator = PRECISION - normalizedSeed
        // crashPoint = numerator / denominator * (BPS_DENOMINATOR / BPS_DENOMINATOR)
        //
        // Simplified to return in basis points:
        // crashPoint = ((BPS_DENOMINATOR - houseEdgeBps) * PRECISION) / (PRECISION - normalizedSeed)

        uint256 numerator = (BPS_DENOMINATOR - uint256(houseEdgeBps)) * PRECISION;
        // Note: denominator is always > 0 because:
        // - normalizedSeed = seed % PRECISION, so normalizedSeed is in range [0, PRECISION-1]
        // - Therefore denominator = PRECISION - normalizedSeed is in range [1, PRECISION]
        uint256 denominator = PRECISION - normalizedSeed;

        // Calculate crash point in basis points
        // crashPointBps = ((10000 - houseEdgeBps) * PRECISION) / (PRECISION - normalizedSeed)
        // Note: rawCrashPoint >= MIN_CRASH_POINT is guaranteed because:
        // - We only reach here when normalizedSeed >= scaledHouseEdge
        // - At the boundary (normalizedSeed = scaledHouseEdge), rawCrashPoint = exactly MIN_CRASH_POINT
        // - For normalizedSeed > scaledHouseEdge, rawCrashPoint > MIN_CRASH_POINT
        uint256 rawCrashPoint = numerator / denominator;

        // Cap at maximum
        if (rawCrashPoint > maxMultiplierBps) {
            rawCrashPoint = maxMultiplierBps;
        }

        // Safe cast (we've bounded the value)
        crashPoint = uint32(rawCrashPoint);
    }

    /**
     * @notice Combine VRF word, server seed, and round ID into a single seed
     * @dev This ensures the crash point is determined by both VRF and server seed
     * @param vrfRandomWord The VRF-provided random word
     * @param serverSeed The operator's pre-committed server seed
     * @param roundId The round identifier
     * @return seed The combined seed for crash point calculation
     */
    function combineSeed(
        uint256 vrfRandomWord,
        bytes32 serverSeed,
        uint256 roundId
    ) internal pure returns (uint256 seed) {
        seed = uint256(keccak256(abi.encodePacked(vrfRandomWord, serverSeed, roundId)));
    }

    /**
     * @notice Calculate payout for a winning bet
     * @param betAmount The original bet amount
     * @param cashoutMultiplierBps The multiplier at which player cashed out (in bps)
     * @return payout The payout amount
     */
    function calculatePayout(
        uint256 betAmount,
        uint32 cashoutMultiplierBps
    ) internal pure returns (uint256 payout) {
        // payout = betAmount * multiplier / 10000
        // e.g., 100 EVA at 1.50x (15000 bps) = 100 * 15000 / 10000 = 150 EVA
        payout = (betAmount * uint256(cashoutMultiplierBps)) / BPS_DENOMINATOR;
    }

    /**
     * @notice Check if a cashout multiplier is valid (player wins)
     * @param cashoutMultiplierBps The player's cashout multiplier
     * @param crashPointBps The round's crash point
     * @return valid True if the player cashed out before crash
     */
    function isValidCashout(
        uint32 cashoutMultiplierBps,
        uint32 crashPointBps
    ) internal pure returns (bool valid) {
        // Player wins if they cashed out BEFORE the crash point (strictly less than)
        // e.g., cashout at 1.50x, crash at 2.00x -> win
        // e.g., cashout at 2.00x, crash at 2.00x -> LOSS (equal = crash)
        // e.g., cashout at 2.50x, crash at 2.00x -> loss
        valid = cashoutMultiplierBps < crashPointBps;
    }

    /**
     * @notice Verify the commit hash matches the revealed server seed
     * @param commitHash The previously committed hash
     * @param serverSeed The revealed server seed
     * @return valid True if the hash matches
     */
    function verifyCommitment(
        bytes32 commitHash,
        bytes32 serverSeed
    ) internal pure returns (bool valid) {
        valid = commitHash == keccak256(abi.encodePacked(serverSeed));
    }

    /**
     * @notice Convert multiplier from basis points to display format
     * @dev For frontend display: 15000 bps -> "1.50x"
     * @param multiplierBps Multiplier in basis points
     * @return wholePart The whole number part (e.g., 1)
     * @return decimalPart The decimal part in hundredths (e.g., 50 for .50)
     */
    function toDisplayMultiplier(uint32 multiplierBps)
        internal
        pure
        returns (uint32 wholePart, uint32 decimalPart)
    {
        wholePart = multiplierBps / 10000;
        decimalPart = (multiplierBps % 10000) / 100;
    }
}

