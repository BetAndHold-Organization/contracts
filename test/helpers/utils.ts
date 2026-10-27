import { expect } from "chai";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { toFunctionSelector } from "viem";

/**
 * 4-byte selectors of every custom error in the compiled artifacts, by name.
 *
 * Under `hardhat test --coverage` the instrumented node often cannot decode a
 * custom error raised inside an inherited modifier (e.g. `NotGameOperator` from
 * the game base) and reports only "unrecognized custom error (return data:
 * 0x3bc1fd98)". Matching the selector as well keeps those assertions exact in
 * both modes.
 */
let errorSelectors: Map<string, Set<string>> | null = null;
function selectorsFor(name: string): Set<string> {
  if (!errorSelectors) {
    errorSelectors = new Map();
    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".json") && !entry.endsWith(".dbg.json")) {
          try {
            const abi = (JSON.parse(readFileSync(full, "utf8")) as { abi?: unknown[] }).abi ?? [];
            for (const item of abi as Array<{ type?: string; name?: string; inputs?: Array<{ type: string }> }>) {
              if (item.type !== "error" || !item.name) continue;
              const sel = toFunctionSelector(`${item.name}(${(item.inputs ?? []).map((i) => i.type).join(",")})`);
              if (!errorSelectors!.has(item.name)) errorSelectors!.set(item.name, new Set());
              errorSelectors!.get(item.name)!.add(sel.toLowerCase());
            }
          } catch {
            /* not an artifact */
          }
        }
      }
    };
    walk(path.resolve(process.cwd(), "artifacts", "contracts"));
  }
  const found = errorSelectors.get(name) ?? new Set<string>();
  // An unknown name may still be a parameterless error: its selector is known.
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) found.add(toFunctionSelector(`${name}()`).toLowerCase());
  return found;
}

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
      const lower = text.toLowerCase();
      const bySelector = [...selectorsFor(expectedMsg)].some((sel) => lower.includes(sel));
      if (!bySelector) {
        expect(text, `expected error to include "${expectedMsg}", got: ${text}`).to.include(expectedMsg);
      }
    }
    return;
  }
  if (succeeded) {
    throw new Error(`expected revert${expectedMsg ? ` with "${expectedMsg}"` : ""} but call succeeded`);
  }
}
