import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AccountLimits, UsageLimitWindow } from "../../contracts/usage";

const run = promisify(execFile);

/** agy's documented /usage is a metadata command, not a model prompt. */
export async function readAntigravityLimits(): Promise<AccountLimits | null> {
  const command =
    process.platform === "win32"
      ? join(
          process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
          "agy",
          "bin",
          "agy.exe",
        )
      : join(homedir(), ".local", "bin", "agy");
  if (!existsSync(command)) return null;
  try {
    const { stdout } = await run(command, ["-p", "/usage", "--output-format", "json"], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    });
    const result = parseAntigravityLimits(JSON.parse(stdout));
    if (result) return result;
  } catch {
    /* No guessed zeros or stale successful status on a failed query. */
  }
  return {
    id: "antigravity",
    name: "AGY",
    windows: [],
    asOf: Date.now(),
    note: "Plan limits unavailable. Refresh Usage to retry.",
  };
}

/** Shapes the agy usage command reports; every field is still checked before use. */
interface AgyUsageGroup {
  readonly name?: unknown;
  readonly buckets?: unknown;
}

interface AgyUsageBucket {
  readonly name?: unknown;
  readonly window?: unknown;
  readonly remaining_fraction?: unknown;
  readonly reset_time?: unknown;
}

export function parseAntigravityLimits(value: unknown, now = Date.now()): AccountLimits | null {
  if (!value || typeof value !== "object") return null;
  const command = (value as { command?: { name?: unknown; data?: { groups?: unknown } } }).command;
  if (command?.name !== "usage" || !Array.isArray(command.data?.groups)) return null;
  const windows: UsageLimitWindow[] = [];
  for (const group of (command.data.groups as (AgyUsageGroup | null)[]).slice(0, 32)) {
    if (!group || typeof group.name !== "string" || !Array.isArray(group.buckets)) continue;
    for (const bucket of (group.buckets as (AgyUsageBucket | null)[]).slice(0, 64)) {
      if (!bucket) continue;
      const left = bucket.remaining_fraction;
      if (typeof left !== "number" || !Number.isFinite(left) || left < 0 || left > 1) continue;
      const period =
        bucket.window === "weekly" ? "Weekly" : bucket.window === "5h" ? "5-hour" : bucket.name;
      if (typeof period !== "string") continue;
      const reset = typeof bucket.reset_time === "string" ? Date.parse(bucket.reset_time) : NaN;
      windows.push({
        label: `${group.name} · ${period}`,
        usedPercent: (1 - left) * 100,
        ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
      });
    }
  }
  return windows.length
    ? { id: "antigravity", name: "AGY", windows, asOf: now, note: "Reported by Antigravity /usage" }
    : null;
}
