import { lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  UsageBreakdown,
  UsageDay,
  UsageHistorySummary,
  UsageHistoryTotals,
  UsageReport,
  UsageTokens,
} from "../../contracts/usage";

const MAX_SUMMARY_BYTES = 8 * 1024 * 1024;
const MAX_SUMMARY_ROWS = 5_000;
const MAX_NORMALIZATION_NOTE_LENGTH = 512;
const READ_CHUNK_BYTES = 64 * 1024;
const HISTORY_PROVIDERS = new Set(["history-codex", "history-claude", "history-agy"]);
const ADDITIVE_PROVIDERS = new Set(["history-codex", "history-claude"]);

type HistoryProvider = "history-codex" | "history-claude" | "history-agy";
type UsageSection = Readonly<{
  totals: UsageTokens;
  days: readonly UsageDay[];
  models: readonly UsageBreakdown[];
  workspaces: readonly UsageBreakdown[];
  threads: readonly UsageBreakdown[];
  sessions: number;
}>;

export type HistoricalUsageRead =
  | Readonly<{
      status: "available";
      summary: UsageSection;
      potentialOverlap?: UsageHistoryTotals;
      history: UsageHistorySummary;
    }>
  | Readonly<{ status: "missing" | "unavailable"; history: UsageHistorySummary }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isEpoch = (value: unknown): value is number =>
  isCount(value) && value > 0 && value <= 8_640_000_000_000_000;

function parseTokens(value: unknown): UsageTokens | null {
  if (!isRecord(value) || !isCount(value.input) || !isCount(value.output)) return null;
  if (!isCount(value.cacheRead) || !isCount(value.cacheWrite) || value.cost !== null) return null;
  const apiCost =
    typeof value.apiCost === "number" && Number.isFinite(value.apiCost) && value.apiCost >= 0
      ? value.apiCost
      : undefined;
  return {
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    cost: null,
    ...(apiCost !== undefined ? { apiCost } : {}),
    ...(isCount(value.unpricedTokens) ? { unpricedTokens: value.unpricedTokens } : {}),
  };
}

function parseProviderMap(
  value: unknown,
  allowed: ReadonlySet<string>,
): Readonly<Record<string, number>> | null {
  if (!isRecord(value) || Object.keys(value).length > HISTORY_PROVIDERS.size) return null;
  const result: Record<string, number> = {};
  for (const [provider, amount] of Object.entries(value)) {
    if (!allowed.has(provider) || !isCount(amount)) return null;
    result[provider] = amount;
  }
  return result;
}

function parseBreakdown(
  value: unknown,
  allowedProviders: ReadonlySet<string>,
  requiredProvider?: HistoryProvider,
): UsageBreakdown | null {
  if (!isRecord(value)) return null;
  const { key, label, detail, provider, replies } = value;
  if (typeof key !== "string" || key.length === 0 || key.length > 512) return null;
  if (typeof label !== "string" || label.length === 0 || label.length > 256) return null;
  if (detail !== undefined && (typeof detail !== "string" || detail.length > 256)) return null;
  if (provider !== undefined && (typeof provider !== "string" || !allowedProviders.has(provider)))
    return null;
  if (requiredProvider && provider !== requiredProvider) return null;
  if (!isCount(replies)) return null;
  const tokens = parseTokens(value.tokens);
  if (!tokens) return null;
  const byProvider =
    value.byProvider === undefined
      ? undefined
      : parseProviderMap(value.byProvider, allowedProviders);
  if (value.byProvider !== undefined && !byProvider) return null;
  return {
    key,
    label,
    ...(detail !== undefined ? { detail } : {}),
    ...(provider !== undefined ? { provider: provider as string } : {}),
    replies,
    tokens,
    ...(byProvider ? { byProvider } : {}),
  };
}

function parseDays(
  value: unknown,
  allowedProviders: ReadonlySet<string>,
): readonly UsageDay[] | null {
  if (!Array.isArray(value) || value.length > MAX_SUMMARY_ROWS) return null;
  const days: UsageDay[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isEpoch(item.dayStart) || !isRecord(item.byModel)) return null;
    const byModel: Record<string, number> = {};
    for (const [key, amount] of Object.entries(item.byModel)) {
      const provider = key.split("/", 1)[0];
      if (!provider || !allowedProviders.has(provider) || key.length > 256 || !isCount(amount))
        return null;
      byModel[key] = amount;
    }
    days.push({ dayStart: item.dayStart, byModel });
  }
  return days;
}

function parseSection(
  value: unknown,
  allowedProviders: ReadonlySet<string>,
  requireOnlyAdditiveProviders: boolean,
): UsageSection | null {
  if (!isRecord(value)) return null;
  const totals = parseTokens(value.totals);
  const days = parseDays(value.days, allowedProviders);
  if (!totals || !days) return null;
  if (!Array.isArray(value.models) || value.models.length > MAX_SUMMARY_ROWS) return null;
  if (!Array.isArray(value.workspaces) || value.workspaces.length > MAX_SUMMARY_ROWS) return null;
  if (!Array.isArray(value.threads) || value.threads.length > MAX_SUMMARY_ROWS) return null;
  if (!isCount(value.sessions)) return null;

  const models: UsageBreakdown[] = [];
  for (const item of value.models) {
    if (
      !isRecord(item) ||
      typeof item.provider !== "string" ||
      !allowedProviders.has(item.provider)
    )
      return null;
    const provider = item.provider as HistoryProvider;
    const parsed = parseBreakdown(item, allowedProviders, provider);
    if (!parsed || !parsed.key.startsWith(`${provider}/`)) return null;
    models.push(parsed);
  }
  const workspaces = value.workspaces.map((row) => parseBreakdown(row, allowedProviders));
  const threads = value.threads.map((row) => parseBreakdown(row, allowedProviders));
  if (workspaces.some((row) => row === null) || threads.some((row) => row === null)) return null;
  if (
    requireOnlyAdditiveProviders &&
    [...models, ...workspaces, ...threads].some((row) =>
      Object.keys(row?.byProvider ?? {}).some((provider) => !ADDITIVE_PROVIDERS.has(provider)),
    )
  ) {
    return null;
  }
  return {
    totals,
    days,
    models,
    workspaces: workspaces as UsageBreakdown[],
    threads: threads as UsageBreakdown[],
    sessions: value.sessions,
  };
}

function parsePotentialOverlap(value: unknown): UsageHistoryTotals | null {
  if (!isRecord(value) || typeof value.label !== "string" || value.label.length > 160) return null;
  const section = parseSection(value, new Set(["history-agy"]), false);
  if (!section) return null;
  return { label: value.label, ...section };
}

function parseSummary(value: unknown): HistoricalUsageRead | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.costAvailable !== false) return null;
  if (!isEpoch(value.generatedAt) || !isRecord(value.report) || !isRecord(value.coverage))
    return null;
  const coverage = value.coverage;
  const tokenCoveragePartial = coverage.tokenCoveragePartial;
  const normalizationNote = coverage.normalizationNote;
  const importRun = coverage.importRun;
  const metrics = coverage.metrics;
  const totalMetrics = isRecord(metrics) ? metrics.total : undefined;
  const mappings = coverage.projectMappings;
  if (
    !isCount(coverage.eventCount) ||
    !isCount(coverage.safeEventCount) ||
    !isCount(coverage.potentialOverlapEventCount) ||
    coverage.safeEventCount + coverage.potentialOverlapEventCount !== coverage.eventCount ||
    !isCount(coverage.duplicateCrossHostEvents) ||
    (tokenCoveragePartial !== undefined && typeof tokenCoveragePartial !== "boolean") ||
    (normalizationNote !== undefined &&
      normalizationNote !== null &&
      (typeof normalizationNote !== "string" ||
        normalizationNote.length === 0 ||
        normalizationNote.length > MAX_NORMALIZATION_NOTE_LENGTH)) ||
    !isEpoch(coverage.generatedAtAsOf) ||
    !isRecord(importRun) ||
    typeof importRun.piCoverageAvailable !== "boolean" ||
    (importRun.status !== undefined &&
      importRun.status !== "in-progress" &&
      importRun.status !== "complete") ||
    typeof coverage.complete !== "boolean" ||
    !isRecord(totalMetrics) ||
    !isCount(totalMetrics.unknown) ||
    !isRecord(mappings) ||
    !isCount(mappings.unknown) ||
    !Array.isArray(coverage.files) ||
    coverage.files.length > 32
  ) {
    return null;
  }
  let sourceFileErrors = 0;
  for (const row of coverage.files) {
    if (
      !isRecord(row) ||
      !isCount(row.files) ||
      (row.status !== "ok" && row.status !== "partial" && row.status !== "error")
    )
      return null;
    if (row.status !== "ok") sourceFileErrors += row.files;
  }
  const safe = parseSection(value.report, ADDITIVE_PROVIDERS, true);
  if (!safe || !isEpoch(value.report.refreshedAt) || !isCount(value.report.unreadable)) return null;
  if (coverage.safeEventCount > 0 && !safe.models.length) return null;
  const potentialValue = value.report.potentialOverlap;
  const potential =
    potentialValue === undefined ? undefined : parsePotentialOverlap(potentialValue);
  if (potentialValue !== undefined && !potential) return null;
  if (coverage.potentialOverlapEventCount > 0 && !potential) return null;
  if (coverage.potentialOverlapEventCount === 0 && potential && potential.sessions > 0) return null;

  const history: UsageHistorySummary = {
    status: "available",
    generatedAt: value.generatedAt,
    asOf: coverage.generatedAtAsOf,
    complete: coverage.complete,
    eventCount: coverage.eventCount,
    safeEventCount: coverage.safeEventCount,
    potentialOverlapEventCount: coverage.potentialOverlapEventCount,
    duplicateCrossHostEvents: coverage.duplicateCrossHostEvents,
    ...(tokenCoveragePartial !== undefined
      ? { tokenCoveragePartial: tokenCoveragePartial as boolean }
      : {}),
    ...(normalizationNote !== undefined
      ? { normalizationNote: normalizationNote as string | null }
      : {}),
    piCoverageAvailable: importRun.piCoverageAvailable,
    sourceFileErrors,
    unknownTotalEvents: totalMetrics.unknown,
    unmappedProjects: mappings.unknown,
    ...(potential ? { potentialOverlap: potential } : {}),
  };
  return {
    status: "available",
    summary: safe,
    ...(potential ? { potentialOverlap: potential } : {}),
    history,
  };
}

async function readBoundedJson(filePath: string): Promise<unknown> {
  const linkInfo = await lstat(filePath);
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink() || linkInfo.size > MAX_SUMMARY_BYTES) {
    throw new Error("summary unavailable");
  }
  const file = await open(filePath, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_SUMMARY_BYTES) throw new Error("summary unavailable");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_SUMMARY_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_SUMMARY_BYTES + 1 - total));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_SUMMARY_BYTES) throw new Error("summary unavailable");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error("summary changed during read");
    }
    const bytes = Buffer.concat(chunks, total);
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(json) as unknown;
  } finally {
    await file.close();
  }
}

function unavailable(status: "missing" | "unavailable"): HistoricalUsageRead {
  const history: UsageHistorySummary = { status };
  return { status, history };
}

/** Read the importer's atomically replaced private summary without scanning raw CLI histories. */
export async function readHistoricalUsageSummary(filePath: string): Promise<HistoricalUsageRead> {
  try {
    const parsed = parseSummary(await readBoundedJson(filePath));
    return parsed ?? unavailable("unavailable");
  } catch (error) {
    return unavailable(isRecord(error) && error.code === "ENOENT" ? "missing" : "unavailable");
  }
}

/** Resolve the summary beside the managed agent profile, whose parent is the ecosystem .state. */
export function usageHistorySummaryPath(agentDir: string): string {
  return join(dirname(agentDir), "usage-history", "summary.json");
}

function mergeTokens(left: UsageTokens, right: UsageTokens): UsageTokens {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    cost: left.cost === null || right.cost === null ? null : left.cost + right.cost,
    apiCost: (left.apiCost ?? 0) + (right.apiCost ?? 0),
    unpricedTokens: (left.unpricedTokens ?? 0) + (right.unpricedTokens ?? 0),
  };
}

function mergeDays(left: readonly UsageDay[], right: readonly UsageDay[]): readonly UsageDay[] {
  const merged = new Map<number, Record<string, number>>();
  for (const day of [...left, ...right]) {
    const byModel = merged.get(day.dayStart) ?? {};
    for (const [model, count] of Object.entries(day.byModel)) {
      byModel[model] = (byModel[model] ?? 0) + count;
    }
    merged.set(day.dayStart, byModel);
  }
  return [...merged]
    .sort(([a], [b]) => a - b)
    .map(([dayStart, byModel]) => ({ dayStart, byModel }));
}

/** Merge only the importer's safe additive section; possible AGY overlap stays separate. */
export function mergeHistoricalUsage(
  native: UsageReport,
  historical: HistoricalUsageRead,
  refreshedAt = Date.now(),
): UsageReport {
  if (historical.status !== "available") return { ...native, history: historical.history };
  const hasSafeHistory = (historical.history.safeEventCount ?? 0) > 0;
  if (!hasSafeHistory) return { ...native, refreshedAt, history: historical.history };
  const safe = historical.summary;
  return {
    ...native,
    refreshedAt,
    totals: mergeTokens(native.totals, safe.totals),
    days: mergeDays(native.days, safe.days),
    models: [...native.models, ...safe.models],
    workspaces: [...native.workspaces, ...safe.workspaces],
    threads: [...native.threads, ...safe.threads],
    history: historical.history,
  };
}
