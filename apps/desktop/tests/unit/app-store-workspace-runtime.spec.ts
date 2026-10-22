import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { JsonCatalogStore } from "@pi-gui/catalogs/node";
import { createJiti } from "jiti";
import type { WorkspaceRef } from "@pi-gui/session-driver";
import type { RuntimeSnapshot, RuntimeSkillRecord } from "@pi-gui/session-driver/runtime-types";
import type { PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import { writePersistedUiState } from "../../electron/persistence/app-store-persistence";
import type { GitWorktreeManager } from "../../electron/platform/worktrees/worktree-manager";

const jiti = createJiti(__filename);
let DesktopAppStore: typeof import("../../electron/application/app-store").DesktopAppStore;
test.beforeAll(async () => {
  ({ DesktopAppStore } = await jiti.import<typeof import("../../electron/application/app-store")>(
    "../../electron/application/app-store.ts",
  ));
});

test("workspace runtime loading preserves project scope and never reloads sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "app-store-workspace-runtime-"));
  const userDataDir = join(root, "user-data");
  const agentDir = join(userDataDir, "agent");
  const workspaceRefs: WorkspaceRef[] = [
    { workspaceId: "alpha", path: join(root, "alpha"), displayName: "Alpha" },
    { workspaceId: "beta", path: join(root, "beta"), displayName: "Beta" },
  ];
  const catalog = new JsonCatalogStore({ catalogFilePath: join(userDataDir, "catalogs.json") });
  await mkdir(userDataDir, { recursive: true });
  for (const [sortOrder, workspace] of workspaceRefs.entries()) {
    await mkdir(workspace.path, { recursive: true });
    await catalog.workspaces.upsertWorkspace({
      ...workspace,
      lastOpenedAt: "2026-10-21T00:00:00Z",
      sortOrder,
    });
  }
  await writePersistedUiState(join(userDataDir, "ui-state.json"), {
    selectedWorkspaceId: "alpha",
  });

  const store = new DesktopAppStore({ userDataDir, initialWorkspacePaths: [] });
  const internals = store as unknown as {
    driver: PiSdkDriver;
    worktreeManager: GitWorktreeManager;
    workspaceOwner: { reconcileWorktrees(): Promise<void> };
    reloadOpenSessions(workspaceIds?: readonly string[]): Promise<boolean>;
  };
  const runtimeSupervisor = internals.driver.runtimeSupervisor as unknown as {
    getRuntimeSnapshot(workspace: WorkspaceRef): Promise<RuntimeSnapshot>;
    refreshRuntime(workspace: WorkspaceRef): Promise<RuntimeSnapshot>;
    getGlobalModelSettings(workspace: WorkspaceRef): Promise<{ enabledModelPatterns: string[] }>;
  };
  const skill = (
    workspace: WorkspaceRef,
    name: string,
    scope: RuntimeSkillRecord["scope"],
    filePath: string,
  ): RuntimeSkillRecord => ({
    name,
    description: name,
    filePath,
    baseDir: workspace.path,
    source: "fixture",
    scope,
    enabled: true,
    disableModelInvocation: false,
    slashCommand: "/skill:" + name,
  });
  const fixtureRuntime = (workspace: WorkspaceRef): RuntimeSnapshot => ({
    workspace,
    providers: [],
    models: [],
    skills: [
      skill(
        workspace,
        "global-guide",
        "user",
        join(agentDir, "skills", "global-guide", "SKILL.md"),
      ),
      skill(
        workspace,
        workspace.workspaceId + "-only",
        "project",
        join(workspace.path, ".agents", "skills", workspace.workspaceId + "-only", "SKILL.md"),
      ),
    ],
    extensions: [],
    settings: { enableSkillCommands: false, enabledModelPatterns: [] },
  });
  runtimeSupervisor.getRuntimeSnapshot = async (workspace) => fixtureRuntime(workspace);
  runtimeSupervisor.getGlobalModelSettings = async () => ({ enabledModelPatterns: [] });
  internals.driver.syncWorkspaces = async () => ({ failures: [] });
  internals.worktreeManager.inspectWorkspace = async (workspace) => ({
    canonicalPath: workspace.path,
    commonDir: join(workspace.path, ".git"),
  });
  internals.worktreeManager.refreshWorktrees = async () => ({ worktrees: [] });
  internals.workspaceOwner.reconcileWorktrees = async () => {};

  let reloadCalls = 0;
  internals.reloadOpenSessions = async () => {
    reloadCalls += 1;
    return true;
  };
  const pendingRefreshes = new Map<string, (snapshot: RuntimeSnapshot) => void>();
  let resolveAllRefreshesStarted!: () => void;
  const allRefreshesStarted = new Promise<void>((resolve) => {
    resolveAllRefreshesStarted = resolve;
  });
  runtimeSupervisor.refreshRuntime = (workspace) =>
    new Promise((resolve) => {
      pendingRefreshes.set(workspace.workspaceId, resolve);
      if (pendingRefreshes.size === 2) resolveAllRefreshesStarted();
    });

  try {
    await store.initialize();
    expect(
      (await store.getState()).runtimeByWorkspace.alpha?.skills.map((entry) => entry.name),
    ).toEqual(["global-guide", "alpha-only"]);

    const alphaRefresh = store.loadWorkspaceRuntime("alpha", { refresh: true });
    const betaRefresh = store.loadWorkspaceRuntime("beta", { refresh: true });
    await allRefreshesStarted;
    expect([...pendingRefreshes.keys()].sort()).toEqual(["alpha", "beta"]);

    pendingRefreshes.get("beta")!(fixtureRuntime(workspaceRefs[1]!));
    const betaState = await betaRefresh;
    expect(betaState.runtimeByWorkspace.beta?.skills.map((entry) => entry.name)).toEqual([
      "global-guide",
      "beta-only",
    ]);

    pendingRefreshes.get("alpha")!(fixtureRuntime(workspaceRefs[0]!));
    const finalState = await alphaRefresh;
    expect(finalState.runtimeByWorkspace.alpha?.skills.map((entry) => entry.name)).toEqual([
      "global-guide",
      "alpha-only",
    ]);
    expect(finalState.runtimeByWorkspace.beta?.skills.map((entry) => entry.name)).toEqual([
      "global-guide",
      "beta-only",
    ]);
    expect(reloadCalls).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
