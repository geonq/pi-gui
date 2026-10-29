import { open, readdir, readFile } from "node:fs/promises";
import { readAntigravityLimits } from "./antigravity-limits";
import { readCodexLiveLimits } from "./codex-limits";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountLimits, UsageLimitWindow } from "../../contracts/usage";

// One provider call per account at most every 5 minutes, and only while Usage is open or refreshed.
const CACHE_MS = 300_000;
const EMPTY_RETRY_MS = 20_000;
const ANTHROPIC = "https://api.anthropic.com";
const OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_WINDOWS = [
  ["five_hour", "5-hour"],
  ["seven_day", "Weekly"],
  ["seven_day_opus", "Weekly · Opus"],
  ["seven_day_sonnet", "Weekly · Sonnet"],
] as const;

interface ClaudeWindow {
  readonly utilization?: number | null;
  readonly resets_at?: string | null;
}

interface CodexWindow {
  readonly used_percent?: number;
  readonly window_minutes?: number;
  readonly resets_at?: number;
}

let cached: { readonly at: number; readonly value: Promise<readonly AccountLimits[]> } | undefined;
let lastRead: readonly AccountLimits[] = [];

/**
 * Remaining subscription quota per signed-in account, re-read at most every five minutes.
 * `claudeDir` holds pi-ecosystem's Claude slots (`<state>/claude/account-N`). `cachedOnly` answers
 * from the last read without contacting any provider (the model picker uses it).
 */
export function readAccountLimits(
  claudeDir: string,
  { cachedOnly = false } = {},
): Promise<readonly AccountLimits[]> {
  if (cachedOnly) return Promise.resolve(lastRead);
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    const value = Promise.all([
      readClaudeLimits(claudeDir),
      readCodexLimitsWithLive(),
      readAntigravityLimits(),
    ]).then(([claude, codex, agy]) => {
      lastRead = [...claude, ...(codex ? [codex] : []), ...(agy ? [agy] : [])];
      // An account without numbers (token not yet renewed, request failed) is re-read on the next
      // open or refresh instead of staying blank for five minutes.
      if (lastRead.some((entry) => entry.windows.length === 0) && cached?.value === value)
        cached = { at: Date.now() - CACHE_MS + EMPTY_RETRY_MS, value };
      return lastRead;
    });
    cached = { at: Date.now(), value };
  }
  return cached.value;
}

/** Each Claude slot the owner signed into: its profile name, and the windows the CLI's own `/usage` reads. */
export async function readClaudeLimits(claudeDir: string): Promise<AccountLimits[]> {
  const slots = (await readdir(claudeDir).catch(() => [] as string[]))
    .map((entry) => /^account-([1-5])$/.exec(entry)?.[1])
    .filter((slot): slot is string => slot !== undefined)
    .sort();
  const results = await Promise.all(
    slots.map((slot) => readClaudeSlot(join(claudeDir, `account-${slot}`), slot)),
  );
  return results.filter((result): result is AccountLimits => result !== null);
}

async function readClaudeSlot(directory: string, slot: string): Promise<AccountLimits | null> {
  const credentials = await readJson<{
    claudeAiOauth?: { accessToken?: string; expiresAt?: number };
  }>(join(directory, ".credentials.json"));
  const auth = credentials?.claudeAiOauth;
  if (!auth?.accessToken) return null;
  // The name the CLI saved from the account profile; it refreshes whenever the CLI runs.
  const profile = await readJson<{ oauthAccount?: { displayName?: string } }>(
    join(directory, ".claude.json"),
  );
  const owner = profile?.oauthAccount?.displayName?.trim();
  const base = {
    id: `claude-code-account-${slot}`,
    name: owner ? `Claude · ${owner}` : `Claude account ${slot}`,
  };
  // The CLI refreshes its own token when it next runs; an expired one means no fresh numbers yet.
  if ((auth.expiresAt ?? 0) < Date.now() + 60_000) {
    return {
      ...base,
      windows: [],
      asOf: Date.now(),
      note: "Refreshes after the next Claude request",
    };
  }
  const usage = await fetch(`${ANTHROPIC}/api/oauth/usage`, {
    headers: { Authorization: `Bearer ${auth.accessToken}`, "anthropic-beta": OAUTH_BETA },
    signal: AbortSignal.timeout(8_000),
  })
    .then((response) =>
      response.ok
        ? (response.json() as Promise<Record<string, ClaudeWindow | null | undefined>>)
        : null,
    )
    .catch(() => null);
  if (!usage) return { ...base, windows: [], asOf: Date.now(), note: "Limits unavailable" };
  const windows: UsageLimitWindow[] = [];
  for (const [key, label] of CLAUDE_WINDOWS) {
    const window = usage[key];
    if (typeof window?.utilization !== "number") continue;
    windows.push({ label, usedPercent: window.utilization, resetsAt: parseTime(window.resets_at) });
  }
  return { ...base, windows, asOf: Date.now() };
}

/** Prefer current account metadata; fall back to the timestamped saved-session snapshot. */
async function readCodexLimitsWithLive(): Promise<AccountLimits | null> {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  const owner = await codexAccountName(home);
  return (await readCodexLiveLimits(owner)) ?? readCodexLimits();
}

/** Codex records the ChatGPT plan's windows on every turn; the newest session holds the latest numbers. */
export async function readCodexLimits(): Promise<AccountLimits | null> {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  const sessions = join(home, "sessions");
  for (const file of await newestFiles(sessions, 3, 5)) {
    const tail = await readTail(file, 512 * 1024);
    const lines = tail.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      if (!line.includes('"rate_limits"')) continue;
      try {
        const record = JSON.parse(line) as {
          timestamp?: string;
          payload?: {
            rate_limits?: { primary?: CodexWindow | null; secondary?: CodexWindow | null };
          };
        };
        const limits = record.payload?.rate_limits;
        const windows = [limits?.primary, limits?.secondary]
          .filter((window): window is CodexWindow => typeof window?.used_percent === "number")
          .sort((a, b) => (a.window_minutes ?? 0) - (b.window_minutes ?? 0))
          .map((window) => ({
            label: windowLabel(window.window_minutes),
            usedPercent: window.used_percent!,
            resetsAt: window.resets_at ? window.resets_at * 1000 : undefined,
          }));
        if (windows.length === 0) continue;
        const asOf = parseTime(record.timestamp);
        if (asOf === undefined) continue;
        const owner = await codexAccountName(home);
        return {
          id: "openai",
          name: owner ? `ChatGPT · ${owner}` : "ChatGPT",
          windows,
          asOf,
          note: "Saved Codex session snapshot; may be stale",
        };
      } catch {
        // A line cut by the tail window; older lines may still hold a full record.
      }
    }
  }
  return null;
}

/**
 * The ChatGPT account's name from Codex's sign-in (`auth.json` → `tokens.id_token`, claim `name`).
 * Codex renews that token when it runs, so a renamed account shows up after the next Codex use. Only the
 * token's public claims are decoded; no secret leaves this function.
 */
async function codexAccountName(home: string): Promise<string | undefined> {
  const auth = await readJson<{ tokens?: { id_token?: string } }>(join(home, "auth.json"));
  const payload = auth?.tokens?.id_token?.split(".")[1];
  if (!payload) return undefined;
  try {
    const name = (
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { name?: unknown }
    ).name;
    return typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : undefined;
  } catch {
    return undefined;
  }
}

function windowLabel(minutes = 0): string {
  if (minutes === 10_080) return "Weekly";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day`;
  return `${Math.round(minutes / 60)}-hour`;
}

/** Newest files under `YYYY/MM/DD` folders, walking only the most recent folders at each level. */
async function newestFiles(root: string, depth: number, limit: number): Promise<string[]> {
  const entries = (await readdir(root, { withFileTypes: true }).catch(() => [])).sort((a, b) =>
    b.name.localeCompare(a.name),
  );
  if (depth === 0) {
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .slice(0, limit)
      .map((entry) => join(root, entry.name));
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    found.push(...(await newestFiles(join(root, entry.name), depth - 1, limit - found.length)));
    if (found.length >= limit) break;
  }
  return found;
}

async function readTail(file: string, bytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function parseTime(value: string | null | undefined): number | undefined {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? undefined : time;
}
