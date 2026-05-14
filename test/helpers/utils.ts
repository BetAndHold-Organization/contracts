import { expect } from "chai";

/**
 * Walks a viem-style error chain and concatenates message-bearing fields.
 * BigInt-safe (avoids JSON.stringify on the raw error).
 */
function errorToString(err: unknown, depth = 0): string {
  if (depth > 10 || err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err !== "object") return String(err);
  const e = err as Record<string, unknown> & { cause?: unknown };
  const parts: string[] = [];
  for (const key of ["message", "shortMessage", "details", "metaMessages", "reason", "name"]) {
    const v = e[key];
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) parts.push(v.map(String).join(" "));
  }
  if (e.cause) parts.push(errorToString(e.cause, depth + 1));
  return parts.join(" | ");
}

/**
 * Asserts that a promise rejects (i.e. an on-chain transaction reverts).
 * Optionally checks that the revert message contains `expectedMsg`.
 */
export async function expectRevert(
  promise: Promise<unknown>,
  expectedMsg?: string,
): Promise<void> {
  let succeeded = false;
  try {
    await promise;
    succeeded = true;
  } catch (err) {
    if (expectedMsg) {
      const text = errorToString(err);
      expect(text, `expected error to include "${expectedMsg}", got: ${text}`).to.include(expectedMsg);
    }
    return;
  }
  if (succeeded) {
    throw new Error(`expected revert${expectedMsg ? ` with "${expectedMsg}"` : ""} but call succeeded`);
  }
}
