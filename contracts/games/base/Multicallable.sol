// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

/**
 * @title Multicallable
 * @notice Best-effort batch executor with per-sub-call revert isolation,
 *         gated to authorized callers (typically operators).
 *
 *         Each entry in `data` is ABI-encoded calldata for a function on this
 *         contract. Each entry is executed via DELEGATECALL to `address(this)`,
 *         so `msg.sender` is preserved and every sub-call sees the same
 *         access-control / EIP-712 / nonce / reentrancy state it would see if
 *         called directly.
 *
 *         Unlike OpenZeppelin's strict `Multicall`, a sub-call that reverts
 *         does NOT abort the batch: its state changes are rolled back at the
 *         EVM level, `successes[i]` is set to false, the revert payload is
 *         recorded in `results[i]`, and a `MulticallSubCallFailed` event is
 *         emitted from the outer frame. Iteration continues.
 *
 *         ──────────────────────────────────────────────────────────────────
 *         Why this is gated rather than permissionless
 *         ──────────────────────────────────────────────────────────────────
 *         In principle this primitive could be permissionless: each sub-call
 *         already enforces its own ACL, so a non-operator caller could only
 *         batch functions THEY could call directly (e.g. their own `startSpin`).
 *         We deliberately gate it anyway because:
 *
 *           - The entrypoint is designed for the operator relayer. Letting
 *             arbitrary callers reuse it complicates indexer/backend filters,
 *             which want to treat `multicallTry` txs as "one operator tick".
 *           - It removes a low-cost event-log griefing vector: a non-operator
 *             can otherwise spam `MulticallSubCallFailed` events by sending
 *             garbage sub-calls that always revert at their own ACLs.
 *           - It shrinks the audit surface: every future public function on
 *             an inheriting contract has to be analyzed as "what happens if
 *             this is batched", and gating to the operator narrows the threat
 *             model to one trusted role.
 *
 *         If a game wants to expose player-side batching, it should add a
 *         dedicated entry (e.g. `batchStartSpinForSelf(...)`) with explicit
 *         per-call invariants, rather than open up `multicallTry`.
 *
 * @dev    Designed for operator backends relaying player-signed `*For` actions:
 *         a single stale-nonce or expired-deadline sub-call no longer reverts
 *         the whole batch, so one bad action cannot grief everyone else in the
 *         bundle.
 *
 *         Per-sub-call invariants preserved:
 *           - `nonReentrant` resets between iterations (revert rolls back the
 *             `_status` flip, success path resets it on function exit).
 *           - Events from a reverted sub-call are wiped along with its state.
 *             Only events emitted by the outer frame survive.
 *           - DELEGATECALL preserves `msg.sender`, `address(this)`, and storage
 *             context, so EIP-712 domain, action nonces, spend caps, and
 *             operator allowlists all behave identically.
 *
 *         Returns success flags AND raw return data per sub-call so backends
 *         can decode results from happy-path calls and inspect revert reasons
 *         from failed ones.
 *
 *         ──────────────────────────────────────────────────────────────────
 *         Gas estimation caveat
 *         ──────────────────────────────────────────────────────────────────
 *         Some clients (observed with viem + hardhat) under-estimate gas for
 *         `multicallTry` because the inner DELEGATECALLs are opaque to the
 *         estimator. The visible symptom is a sub-call that should succeed
 *         reverting with empty return data (out-of-gas at the inner frame).
 *         Operator backends should provide an explicit gas limit (or call
 *         `eth_estimateGas` with a generous buffer and pass the result via
 *         `tx.gas`) rather than rely on auto-estimate.
 *
 *         ──────────────────────────────────────────────────────────────────
 *         How the gate is wired
 *         ──────────────────────────────────────────────────────────────────
 *         The inheriting contract implements `_multicallAuthorized(caller)`.
 *         Shape bases that already hold an `authHub` reference (PushVRFGame /
 *         PullVRFGame / OperatorGame, plus ProgressiveJackpot) override it as
 *         `authHub.isOperator(caller)`, so the gate matches the same operator
 *         allowlist used by every `*For` entry. A game that wants a stricter
 *         policy (e.g. a specific multicall-only role) can override further.
 */
abstract contract Multicallable {
    error NotAuthorizedMulticaller(address caller);

    event MulticallSubCallFailed(uint256 indexed index, bytes returnData);

    /**
     * @dev Authorize check for `multicallTry`. Inheriting contract MUST implement.
     *      The standard implementation in this codebase delegates to
     *      `AuthHub.isOperator(caller)` so the gate tracks the same allowlist
     *      used by every operator-relayed entry.
     */
    function _multicallAuthorized(address caller) internal view virtual returns (bool);

    /**
     * @param data Array of ABI-encoded sub-calls (selector + args).
     * @return successes Per-sub-call success flag, in input order.
     * @return results  Per-sub-call return payload (return value on success,
     *                  revert reason on failure).
     */
    function multicallTry(bytes[] calldata data)
        external
        returns (bool[] memory successes, bytes[] memory results)
    {
        if (!_multicallAuthorized(msg.sender)) revert NotAuthorizedMulticaller(msg.sender);

        uint256 len = data.length;
        successes = new bool[](len);
        results = new bytes[](len);
        for (uint256 i; i < len;) {
            (bool ok, bytes memory ret) = address(this).delegatecall(data[i]);
            successes[i] = ok;
            results[i] = ret;
            if (!ok) emit MulticallSubCallFailed(i, ret);
            unchecked { ++i; }
        }
    }
}
