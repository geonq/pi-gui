import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { parseCodexLiveLimits } from "../../electron/usage/codex-limits";
import { readClaudeLimits, readCodexLimits } from "../../electron/usage/account-limits";

// Records in the shape Codex writes them (sessions/YYYY/MM/DD/rollout-*.jsonl, one event per line).
const tokenCount = (timestamp: string, rateLimits: unknown) =>
  JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", rate_limits: rateLimits },
  });

test("reads the newest Codex session's plan windows and shows only the windows the plan has", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-codex-home-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const older = join(home, "sessions", "2026", "10", "19");
    const newer = join(home, "sessions", "2026", "10", "20");
    await mkdir(older, { recursive: true });
    await mkdir(newer, { recursive: true });
    await writeFile(
      join(older, "rollout-2026-10-19T08-00-00-a.jsonl"),
      tokenCount("2026-10-19T08:00:00.000Z", {
        primary: { used_percent: 40, window_minutes: 300, resets_at: 1_792_000_000 },
        secondary: { used_percent: 10, window_minutes: 10_080, resets_at: 1_792_500_000 },
      }),
    );
    // The newest session ends with a line without limits and a weekly-only plan before it.
    await writeFile(
      join(newer, "rollout-2026-10-20T17-35-41-b.jsonl"),
      [
        tokenCount("2026-10-20T17:35:41.778Z", {
          primary: { used_percent: 2, window_minutes: 10_080, resets_at: 1_793_083_201 },
          secondary: null,
        }),
        JSON.stringify({
          timestamp: "2026-10-20T17:36:00.000Z",
          type: "event_msg",
          payload: { type: "agent_message" },
        }),
      ].join("\n"),
    );

    // Codex's sign-in token carries the account name as a claim.
    const claims = Buffer.from(JSON.stringify({ name: "Alex", email: "x@example.com" })).toString(
      "base64url",
    );
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify({ tokens: { id_token: `e30.${claims}.sig` } }),
    );

    const limits = await readCodexLimits();
    expect(limits).toEqual({
      id: "openai",
      name: "ChatGPT · Alex",
      windows: [{ label: "Weekly", usedPercent: 2, resetsAt: 1_793_083_201_000 }],
      asOf: Date.parse("2026-10-20T17:35:41.778Z"),
      note: "Saved Codex session snapshot; may be stale",
    });
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("parses current Codex app-server quota windows and reset times", () => {
  const asOf = 1_798_000_000_000;
  expect(
    parseCodexLiveLimits(
      {
        result: {
          rateLimits: {
            primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: "2026-10-21T12:00:00Z" },
            secondary: { usedPercent: 12.5, windowDurationMins: 10_080, resetsAt: 1_792_500_000 },
          },
        },
      },
      "Alex",
      asOf,
    ),
  ).toEqual({
    id: "openai",
    name: "ChatGPT · Alex",
    windows: [
      { label: "5-hour", usedPercent: 40, resetsAt: Date.parse("2026-10-21T12:00:00Z") },
      { label: "Weekly", usedPercent: 12.5, resetsAt: 1_792_500_000_000 },
    ],
    asOf,
    note: "Live Codex account limits",
  });
});

test("invalid live quota values do not become zero-percent windows", () => {
  expect(
    parseCodexLiveLimits({
      rateLimits: {
        primary: { usedPercent: Number.NaN, windowDurationMins: 300 },
        secondary: { usedPercent: 101, windowDurationMins: 10_080 },
      },
    }),
  ).toBeNull();
});

test("no Codex history means no ChatGPT row", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-codex-empty-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    expect(await readCodexLimits()).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("a saved Codex quota without a timestamp is not presented as fresh", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-codex-untimestamped-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const day = join(home, "sessions", "2026", "10", "20");
    await mkdir(day, { recursive: true });
    await writeFile(
      join(day, "rollout-untimestamped.jsonl"),
      tokenCount("", { primary: { used_percent: 10, window_minutes: 300 } }),
    );
    expect(await readCodexLimits()).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("a Claude slot with an expired token shows its saved name without calling the provider", async () => {
  const state = await mkdtemp(join(tmpdir(), "pi-claude-slots-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(state, "no-codex");
  try {
    const slot = join(state, "account-1");
    await mkdir(slot, { recursive: true });
    await mkdir(join(state, "account-2"));
    await writeFile(
      join(slot, ".claude.json"),
      JSON.stringify({ oauthAccount: { displayName: "work" } }),
    );
    await writeFile(
      join(slot, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "expired", expiresAt: Date.now() - 1 } }),
    );

    const limits = await readClaudeLimits(state);
    // Slot 2 has no sign-in, so it is left out.
    expect(limits.map(({ id, name, windows, note }) => ({ id, name, windows, note }))).toEqual([
      {
        id: "claude-code-account-1",
        name: "Claude · work",
        windows: [],
        note: "Refreshes after the next Claude request",
      },
    ]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(state, { recursive: true, force: true });
  }
});
