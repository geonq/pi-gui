import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { UsageReport } from "../../contracts/usage";
import {
  mergeHistoricalUsage,
  readHistoricalUsageSummary,
  usageHistorySummaryPath,
} from "../../electron/usage/historical-usage";

const dayStart = 1_798_041_600_000;
const tokens = (input: number, output: number, cost: number | null = null) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  cost,
});

function historySummary() {
  return {
    schemaVersion: 1,
    generatedAt: 1_798_041_700_000,
    costAvailable: false,
    report: {
      refreshedAt: 1_798_041_700_000,
      totals: tokens(100, 20),
      days: [{ dayStart, byModel: { "history-codex/gpt-6": 120 } }],
      models: [
        {
          key: "history-codex/gpt-6",
          label: "gpt-6",
          provider: "history-codex",
          replies: 1,
          tokens: tokens(100, 20),
        },
      ],
      workspaces: [
        {
          key: "a".repeat(64),
          label: "Pegasus",
          detail: "Canonical project mapping unknown",
          replies: 1,
          tokens: tokens(100, 20),
          byProvider: { "history-codex": 120 },
        },
      ],
      threads: [
        {
          key: "b".repeat(64),
          label: "Codex CLI history",
          detail: "gpt-6",
          provider: "history-codex",
          replies: 1,
          tokens: tokens(100, 20),
          byProvider: { "history-codex": 120 },
        },
      ],
      sessions: 1,
      unreadable: 0,
      potentialOverlap: {
        label: "Antigravity CLI history; possible Pi overlap",
        totals: tokens(40, 10),
        days: [{ dayStart, byModel: { "history-agy/gemini": 50 } }],
        models: [
          {
            key: "history-agy/gemini",
            label: "gemini",
            provider: "history-agy",
            replies: 1,
            tokens: tokens(40, 10),
          },
        ],
        workspaces: [
          {
            key: "c".repeat(64),
            label: "Pegasus",
            replies: 1,
            tokens: tokens(40, 10),
            byProvider: { "history-agy": 50 },
          },
        ],
        threads: [
          {
            key: "d".repeat(64),
            label: "AGY CLI history",
            detail: "gemini",
            provider: "history-agy",
            replies: 1,
            tokens: tokens(40, 10),
            byProvider: { "history-agy": 50 },
          },
        ],
        sessions: 1,
      },
    },
    coverage: {
      eventCount: 2,
      safeEventCount: 1,
      potentialOverlapEventCount: 1,
      duplicateCrossHostEvents: 0,
      files: [{ host: "windows", harness: "codex", status: "ok", files: 1 }],
      metrics: { total: { known: 2, unknown: 0 } },
      projectMappings: { mapped: 0, unknown: 1 },
      importRun: { piCoverageAvailable: false, status: "in-progress" },
      generatedAtAsOf: 1_798_041_700_000,
      complete: false,
    },
  };
}

const nativeReport: UsageReport = {
  refreshedAt: dayStart,
  totals: tokens(10, 5, 0.25),
  days: [{ dayStart, byModel: { "openai-codex/gpt-6": 15 } }],
  models: [
    {
      key: "openai-codex/gpt-6",
      label: "gpt-6",
      provider: "openai-codex",
      replies: 1,
      tokens: tokens(10, 5, 0.25),
    },
  ],
  workspaces: [],
  threads: [],
  sessions: 2,
  unreadable: 0,
};

test("merges only safe history and keeps possible AGY overlap and unknown cost separate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-usage-history-"));
  const file = join(dir, "summary.json");
  try {
    await writeFile(file, JSON.stringify(historySummary()), "utf8");
    const loaded = await readHistoricalUsageSummary(file);
    expect(loaded.status).toBe("available");
    if (loaded.status !== "available") throw new Error("expected a valid summary");

    const merged = mergeHistoricalUsage(nativeReport, loaded, dayStart + 1);
    expect(merged.totals).toEqual(tokens(110, 25, null));
    expect(merged.sessions).toBe(2);
    expect(merged.days).toEqual([
      {
        dayStart,
        byModel: { "openai-codex/gpt-6": 15, "history-codex/gpt-6": 120 },
      },
    ]);
    expect(merged.models.map((row) => row.provider)).toEqual(["openai-codex", "history-codex"]);
    expect(merged.models[1]?.tokens.cost).toBeNull();
    expect(merged.history?.piCoverageAvailable).toBe(false);
    expect(merged.history?.complete).toBe(false);
    expect(merged.history?.potentialOverlap?.totals).toEqual(tokens(40, 10));
    expect(merged.history?.potentialOverlap?.days[0]?.byModel).toEqual({
      "history-agy/gemini": 50,
    });
    expect(merged.days[0]?.byModel).not.toHaveProperty("history-agy/gemini");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("keeps partial token coverage distinct from completed inventory and accepts legacy summaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-usage-history-partial-"));
  const file = join(dir, "summary.json");
  try {
    const source = historySummary();
    const normalizationNote =
      "Some Codex sessions have ambiguous source trajectories or token categories and are excluded from additive totals.";
    const partial = {
      ...source,
      coverage: {
        ...source.coverage,
        complete: true,
        importRun: { ...source.coverage.importRun, status: "complete" },
        tokenCoveragePartial: true,
        normalizationNote,
      },
    };
    await writeFile(file, JSON.stringify(partial), "utf8");
    const loaded = await readHistoricalUsageSummary(file);
    expect(loaded.status).toBe("available");
    if (loaded.status !== "available") throw new Error("expected a valid partial summary");
    expect(loaded.history.complete).toBe(true);
    expect(loaded.history.tokenCoveragePartial).toBe(true);
    expect(loaded.history.normalizationNote).toBe(normalizationNote);

    await writeFile(file, JSON.stringify(source), "utf8");
    const legacy = await readHistoricalUsageSummary(file);
    expect(legacy.status).toBe("available");
    if (legacy.status !== "available") throw new Error("expected a valid legacy summary");
    expect(legacy.history.tokenCoveragePartial).toBeUndefined();

    for (const invalidCoverage of [
      { ...partial.coverage, tokenCoveragePartial: "yes" },
      { ...partial.coverage, normalizationNote: "x".repeat(513) },
    ]) {
      await writeFile(file, JSON.stringify({ ...source, coverage: invalidCoverage }), "utf8");
      expect((await readHistoricalUsageSummary(file)).status).toBe("unavailable");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing and malformed summaries leave native totals intact with explicit status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-usage-history-status-"));
  const file = join(dir, "summary.json");
  try {
    const missing = await readHistoricalUsageSummary(file);
    expect(missing.status).toBe("missing");
    expect(mergeHistoricalUsage(nativeReport, missing).totals).toEqual(nativeReport.totals);

    await writeFile(file, "{invalid json", "utf8");
    const corrupt = await readHistoricalUsageSummary(file);
    expect(corrupt.status).toBe("unavailable");
    expect(mergeHistoricalUsage(nativeReport, corrupt).history?.status).toBe("unavailable");
    expect(mergeHistoricalUsage(nativeReport, corrupt).totals).toEqual(nativeReport.totals);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects oversized summaries and resolves the managed profile's private state path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-usage-history-size-"));
  const file = join(dir, "summary.json");
  try {
    await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    expect((await readHistoricalUsageSummary(file)).status).toBe("unavailable");
    expect(usageHistorySummaryPath(join("profile-root", ".state", "agent"))).toBe(
      join("profile-root", ".state", "usage-history", "summary.json"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
