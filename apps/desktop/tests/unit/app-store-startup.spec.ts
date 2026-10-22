import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { JsonCatalogStore } from "@pi-gui/catalogs/node";
import { createJiti } from "jiti";

// Match the existing unit harness for ESM-only runtime dependencies.
const jiti = createJiti(__filename);
let DesktopAppStore: typeof import("../../electron/application/app-store").DesktopAppStore;
test.beforeAll(async () => {
  ({ DesktopAppStore } = await jiti.import<typeof import("../../electron/application/app-store")>(
    "../../electron/application/app-store.ts",
  ));
});
import type { PiSdkDriver } from "@pi-gui/pi-sdk-driver";
import type { ModelSettingsSnapshot, RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { WorkspaceRef } from "@pi-gui/session-driver";
import { writePersistedUiState } from "../../electron/persistence/app-store-persistence";
import type { GitWorktreeManager } from "../../electron/platform/worktrees/worktree-manager";

test("returns cached startup state while Git discovery is pending, then refreshes once", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "app-store-startup-"));
  const userDataDir = join(testRoot, "user-data");
  const workspacePath = join(testRoot, "repo");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });

  const workspace: WorkspaceRef = {
    workspaceId: "startup-workspace",
    path: workspacePath,
    displayName: "Startup workspace",
  };
  const catalog = new JsonCatalogStore({ catalogFilePath: join(userDataDir, "catalogs.json") });
  const timestamp = "2026-10-20T00:00:00.000Z";
  await catalog.workspaces.upsertWorkspace({
    workspaceId: workspace.workspaceId,
    path: workspace.path,
    displayName: workspace.displayName ?? "Startup workspace",
    lastOpenedAt: timestamp,
    sortOrder: 0,
  });
  const cachedWorktree = {
    worktreeId: "cached-worktree",
    workspaceId: workspace.workspaceId,
    path: join(workspacePath, "cached"),
    displayName: "Cached worktree",
    kind: "linked" as const,
    status: "ready" as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const refreshedWorktree = {
    ...cachedWorktree,
    worktreeId: "refreshed-worktree",
    path: join(workspacePath, "refreshed"),
    displayName: "Refreshed worktree",
  };
  await catalog.worktrees.replaceWorkspaceWorktrees(workspace.workspaceId, [cachedWorktree]);
  await writePersistedUiState(join(userDataDir, "ui-state.json"), {
    selectedWorkspaceId: workspace.workspaceId,
    composerDraft: "restored draft",
  });

  const store = new DesktopAppStore({ userDataDir, initialWorkspacePaths: [] });
  const internals = store as unknown as {
    driver: PiSdkDriver;
    catalogStore: JsonCatalogStore;
    worktreeManager: GitWorktreeManager;
    workspaceOwner: { reconcileWorktrees(): Promise<void> };
  };
  const runtimeSupervisor = internals.driver.runtimeSupervisor as unknown as {
    getRuntimeSnapshot(workspace: WorkspaceRef): Promise<RuntimeSnapshot>;
    getGlobalModelSettings(workspace: WorkspaceRef): Promise<ModelSettingsSnapshot>;
  };
  runtimeSupervisor.getRuntimeSnapshot = async (runtimeWorkspace) => ({
    workspace: runtimeWorkspace,
    providers: [],
    models: [],
    skills: [],
    extensions: [],
    settings: { enableSkillCommands: false, enabledModelPatterns: [] },
  });
  runtimeSupervisor.getGlobalModelSettings = async () => ({ enabledModelPatterns: [] });
  let syncBatchCalls = 0;
  internals.driver.syncWorkspaces = async (workspaces) => {
    syncBatchCalls += 1;
    expect(workspaces).toHaveLength(1);
    return { failures: [] };
  };

  let resolveInspectionStarted!: () => void;
  const inspectionStarted = new Promise<void>((resolve) => {
    resolveInspectionStarted = resolve;
  });
  let releaseInspection!: () => void;
  const inspectionGate = new Promise<void>((resolve) => {
    releaseInspection = resolve;
  });
  let inspectionCalls = 0;
  let refreshCalls = 0;
  let reconcileCalls = 0;
  let resolveReconcile!: () => void;
  const reconciled = new Promise<void>((resolve) => {
    resolveReconcile = resolve;
  });
  const originalInspectWorkspace = internals.worktreeManager.inspectWorkspace;
  const originalRefreshWorktrees = internals.worktreeManager.refreshWorktrees;
  const originalReconcileWorktrees = internals.workspaceOwner.reconcileWorktrees;
  internals.worktreeManager.inspectWorkspace = async (inspectedWorkspace) => {
    inspectionCalls += 1;
    resolveInspectionStarted();
    await inspectionGate;
    return {
      canonicalPath: inspectedWorkspace.path,
      commonDir: join(inspectedWorkspace.path, ".git"),
    };
  };
  internals.worktreeManager.refreshWorktrees = async (refreshedWorkspace) => {
    refreshCalls += 1;
    await internals.catalogStore.worktrees.replaceWorkspaceWorktrees(
      refreshedWorkspace.workspaceId,
      [refreshedWorktree],
    );
    return { worktrees: [refreshedWorktree] };
  };
  internals.workspaceOwner.reconcileWorktrees = async () => {
    reconcileCalls += 1;
    resolveReconcile();
  };

  let unsubscribe: (() => void) | undefined;
  try {
    await store.initialize();
    expect(syncBatchCalls).toBe(1);
    const initialState = await store.getState();
    expect(initialState.selectedWorkspaceId).toBe(workspace.workspaceId);
    expect(initialState.composerDraft).toBe("restored draft");
    expect(initialState.worktreesByWorkspace[workspace.workspaceId]?.map((row) => row.id)).toEqual([
      cachedWorktree.worktreeId,
    ]);

    await inspectionStarted;
    const stateWhileGitIsPending = await store.getState();
    expect(inspectionCalls).toBe(1);
    expect(refreshCalls).toBe(0);
    expect(stateWhileGitIsPending.selectedWorkspaceId).toBe(workspace.workspaceId);
    expect(stateWhileGitIsPending.composerDraft).toBe("restored draft");
    expect(
      stateWhileGitIsPending.worktreesByWorkspace[workspace.workspaceId]?.map((row) => row.id),
    ).toEqual([cachedWorktree.worktreeId]);

    const refreshedState = new Promise<Awaited<ReturnType<typeof store.getState>>>((resolve) => {
      unsubscribe = store.subscribe((state) => {
        if (
          state.worktreesByWorkspace[workspace.workspaceId]?.some(
            (row) => row.id === refreshedWorktree.worktreeId,
          )
        ) {
          resolve(state);
        }
      });
    });
    releaseInspection();
    const finalState = await refreshedState;
    await reconciled;

    expect(finalState.selectedWorkspaceId).toBe(workspace.workspaceId);
    expect(finalState.composerDraft).toBe("restored draft");
    expect(refreshCalls).toBe(1);
    expect(reconcileCalls).toBe(1);
  } finally {
    releaseInspection();
    unsubscribe?.();
    internals.worktreeManager.inspectWorkspace = originalInspectWorkspace;
    internals.worktreeManager.refreshWorktrees = originalRefreshWorktrees;
    internals.workspaceOwner.reconcileWorktrees = originalReconcileWorktrees;
    await rm(testRoot, { recursive: true, force: true });
  }
});

test("inactive project extensions load on selection rather than delaying startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "lazy-project-startup-"));
  const catalog = new JsonCatalogStore({ catalogFilePath: join(root, "catalogs.json") });
  const workspaces = ["primary", "inactive"].map((id) => ({
    workspaceId: id,
    path: join(root, id),
    displayName: id,
  }));
  for (const ws of workspaces) {
    await mkdir(ws.path, { recursive: true });
    await catalog.workspaces.upsertWorkspace({
      ...ws,
      lastOpenedAt: "2026-10-21T00:00:00Z",
      sortOrder: ws.workspaceId === "primary" ? 0 : 1,
    });
  }
  await writePersistedUiState(join(root, "ui-state.json"), { selectedWorkspaceId: "primary" });
  const store = new DesktopAppStore({ userDataDir: root, initialWorkspacePaths: [] });
  const internals = store as unknown as {
    driver: PiSdkDriver;
    worktreeManager: GitWorktreeManager;
    workspaceOwner: { reconcileWorktrees(): Promise<void> };
  };
  const loaded: string[] = [];
  internals.driver.runtimeSupervisor.getRuntimeSnapshot = async (workspace) => {
    loaded.push(workspace.workspaceId);
    return {
      workspace,
      providers: [],
      models: [],
      skills: [],
      extensions: [],
      settings: { enableSkillCommands: false, enabledModelPatterns: [] },
    };
  };
  internals.driver.runtimeSupervisor.getGlobalModelSettings = async () => ({
    enabledModelPatterns: [],
  });
  let syncBatchCalls = 0;
  internals.driver.syncWorkspaces = async (syncWorkspaces) => {
    syncBatchCalls += 1;
    expect(syncWorkspaces).toHaveLength(2);
    return { failures: [] };
  };
  internals.worktreeManager.inspectWorkspace = async (ws) => ({
    canonicalPath: ws.path,
    commonDir: join(ws.path, ".git"),
  });
  internals.worktreeManager.refreshWorktrees = async () => ({ worktrees: [] });
  internals.workspaceOwner.reconcileWorktrees = async () => {};
  try {
    await store.initialize();
    expect(syncBatchCalls).toBe(1);
    expect(loaded).toEqual(["primary"]);
    expect((await store.getState()).workspaces).toHaveLength(2);
    await store.selectWorkspace("inactive");
    expect(loaded).toEqual(["primary", "inactive"]);
    expect((await store.getState()).selectedWorkspaceId).toBe("inactive");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
