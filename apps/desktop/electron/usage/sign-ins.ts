import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SignInStatus } from "../../contracts/usage";

const EVERY_MS = 60 * 60_000;
const EXPIRY_WARNING_MS = 3 * 24 * 60 * 60_000;

interface SignInPaths {
  /** pi-ecosystem's `.state` (holds `agent/auth.json` and `claude/account-N`). */
  readonly stateDir: string;
  /** Where the last notified states are remembered across restarts. */
  readonly memoryFile: string;
  readonly claudeCommand?: string;
}

const run = (file: string, args: readonly string[], env?: NodeJS.ProcessEnv) =>
  new Promise<{ output: string; interrupted: boolean }>((resolve) => {
    execFile(file, args, { env: env ?? process.env, timeout: 12_000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) =>
      resolve({ output: stdout ?? "", interrupted: Boolean(error?.killed || (error && typeof error.code !== "number")) }),
    );
  });

/** Only an explicit completed CLI status can establish a lost login. */
export function parseClaudeAuthStatus(output: string, interrupted = false): SignInStatus["state"] {
  if (interrupted) return "unknown";
  try {
    const value: unknown = JSON.parse(output);
    if (!value || typeof value !== "object" || !("loggedIn" in value)) return "unknown";
    return value.loggedIn === true ? "ok" : value.loggedIn === false ? "signed-out" : "unknown";
  } catch {
    return "unknown";
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Every Claude slot Pi is allowed to use: `claude auth status` (local), plus the refresh token's end date. */
async function claudeSignIns({ stateDir, claudeCommand }: SignInPaths, now: number): Promise<SignInStatus[]> {
  const ledger = await readJson<{ accounts?: Record<string, { approved?: boolean }> }>(join(stateDir, "claude", "accounts.json"));
  const slots = Object.entries(ledger?.accounts ?? {}).filter(([, record]) => record.approved === true);
  if (!claudeCommand || !existsSync(claudeCommand)) return [];
  return Promise.all(
    slots.map(async ([id]): Promise<SignInStatus> => {
      const slot = /(\d)$/.exec(id)?.[1] ?? "?";
      const directory = join(stateDir, "claude", `account-${slot}`);
      const profile = await readJson<{ oauthAccount?: { displayName?: string } }>(join(directory, ".claude.json"));
      const owner = profile?.oauthAccount?.displayName?.trim();
      const name = owner ? `Claude · ${owner}` : `Claude account ${slot}`;
      const fix = `Run scripts\\Login-Claude.ps1 ${slot} (Mac: scripts/Login-Claude.sh ${slot}) in pi-ecosystem.`;
      const result = await run(claudeCommand, ["auth", "status"], { ...process.env, CLAUDE_CONFIG_DIR: directory });
      const state = parseClaudeAuthStatus(result.output, result.interrupted);
      if (state !== "ok") return { id, name, state, ...(state === "signed-out" ? { fix } : {}) };
      const credentials = await readJson<{ claudeAiOauth?: { refreshTokenExpiresAt?: number } }>(join(directory, ".credentials.json"));
      const expiresAt = credentials?.claudeAiOauth?.refreshTokenExpiresAt;
      if (expiresAt && expiresAt - now < EXPIRY_WARNING_MS) return { id, name, state: "expiring", expiresAt, fix };
      return { id, name, state: "ok", expiresAt };
    }),
  );
}

/** Pi's own ChatGPT sign-in renews itself; it is only "signed out" when the stored login is gone. */
async function openAiSignIn({ stateDir }: SignInPaths): Promise<SignInStatus> {
  const auth = await readJson<{ openai?: { refresh?: string } }>(join(stateDir, "agent", "auth.json"));
  return auth?.openai?.refresh
    ? { id: "openai", name: "ChatGPT (Pi)", state: "ok" }
    : { id: "openai", name: "ChatGPT (Pi)", state: "signed-out", fix: "Run scripts\\Login-OpenAI.ps1 in pi-ecosystem." };
}

/** agy says "sign in" when its login is gone; `agy models` lists models only (no model call). */
async function antigravitySignIn(): Promise<SignInStatus | null> {
  const agy = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "agy", "bin", "agy.exe")
    : join(homedir(), ".local", "bin", "agy");
  if (!existsSync(agy)) return null;
  const { output, interrupted } = await run(agy, ["models"]);
  if (interrupted) return { id: "antigravity", name: "AGY", state: "unknown" };
  if (/sign in/i.test(output)) return { id: "antigravity", name: "Antigravity", state: "signed-out", fix: "Run `agy` in a terminal and sign in there." };
  return /\t/.test(output) ? { id: "antigravity", name: "Antigravity", state: "ok" } : null;
}

/** The Codex CLI login (also the source of the ChatGPT limits and name). */
async function codexSignIn(): Promise<SignInStatus | null> {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  if (!existsSync(home)) return null;
  const auth = await readJson<{ tokens?: { refresh_token?: string } }>(join(home, "auth.json"));
  return auth?.tokens?.refresh_token
    ? { id: "codex", name: "Codex CLI", state: "ok" }
    : { id: "codex", name: "Codex CLI", state: "signed-out", fix: "Run `codex login` in a terminal." };
}

export async function checkSignIns(paths: SignInPaths, now = Date.now()): Promise<SignInStatus[]> {
  const settled = await Promise.allSettled([claudeSignIns(paths, now), openAiSignIn(paths), antigravitySignIn(), codexSignIn()]);
  return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value].flat() : [])).filter((entry): entry is SignInStatus => entry !== null);
}

/**
 * Checks every sign-in at start and hourly. A sign-in that becomes signed-out or expiring raises one
 * notification (remembered across restarts, so the same problem never notifies twice).
 */
export function startSignInMonitor(
  paths: SignInPaths,
  notify: (problem: SignInStatus) => void,
  check: (paths: SignInPaths) => Promise<SignInStatus[]> = checkSignIns,
) {
  let latest: readonly SignInStatus[] = [];
  const tick = async () => {
    const statuses = await check(paths);
    latest = statuses;
    const notified = (await readJson<Record<string, string>>(paths.memoryFile)) ?? {};
    const next: Record<string, string> = {};
    for (const status of statuses) {
      if (status.state === "unknown") {
        const previousNotice = notified[status.id];
        if (previousNotice) next[status.id] = previousNotice;
        continue;
      }
      if (status.state === "ok") continue;
      next[status.id] = status.state;
      if (notified[status.id] !== status.state) notify(status);
    }
    await mkdir(dirname(paths.memoryFile), { recursive: true });
    await writeFile(paths.memoryFile, JSON.stringify(next));
  };
  const first = setTimeout(() => void tick().catch(() => undefined), 20_000);
  const timer = setInterval(() => void tick().catch(() => undefined), EVERY_MS);
  return {
    current: () => latest,
    /** Runs a check now (also what the timers call). */
    checkNow: tick,
    stop: () => {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
