import { expect, test } from "@playwright/test";
import type { PiDesktopApi } from "../../contracts/ipc";
import { createEmptyDesktopAppState } from "../../contracts/desktop-state";
import type { RemoteDesktopClientPreferences } from "../../electron/remote/remote-desktop-client-preferences";
import { createRemoteDesktopClientApi } from "../../electron/remote/remote-desktop-client-preload";
import { validateRemoteDesktopInvocation } from "../../electron/remote/remote-desktop-policy";
import {
  isRemoteDesktopMethod,
  isRemoteDesktopPiMethod,
} from "../../electron/remote/remote-desktop-protocol";
import type {
  RemoteDesktopEvent,
  RemoteDesktopMethod,
} from "../../electron/remote/remote-desktop-protocol";

test("remote client keeps Mac presentation and draft local while actions target the Windows backend", async () => {
  let preferences: RemoteDesktopClientPreferences = {
    enableTransparency: false,
    themeMode: "light",
    themePresetId: "default",
  };
  const invocations: Array<{ method: RemoteDesktopMethod; args: readonly unknown[] }> = [];
  let eventListener: ((event: RemoteDesktopEvent) => void) | undefined;
  const usageReport = {
    refreshedAt: 1_792_600_000_000,
    totals: { input: 12, output: 7, cacheRead: 5, cacheWrite: 2, cost: 0.001 },
    days: [],
    models: [],
    workspaces: [],
    threads: [],
    sessions: 1,
    unreadable: 0,
  };
  const hostState = {
    ...createEmptyDesktopAppState(),
    composerDraft: "Windows draft must stay private",
    enableTransparency: true,
    themeMode: "dark" as const,
  };
  const api = createRemoteDesktopClientApi(
    {
      getState: async () => createEmptyDesktopAppState(),
      updateComposerDraft: async () => createEmptyDesktopAppState(),
      submitComposer: async () => createEmptyDesktopAppState(),
      archiveSession: async () => createEmptyDesktopAppState(),
      unarchiveSession: async () => createEmptyDesktopAppState(),
      setThreadGrouping: async () => createEmptyDesktopAppState(),
      loadWorkspaceRuntime: async () => createEmptyDesktopAppState(),
      readClipboardImage: () => ({ kind: "none" }),
      getUsageReport: async () => usageReport,
      onStateChanged: () => () => undefined,
    } as unknown as PiDesktopApi,
    async (method, args) => {
      invocations.push({ method, args });
      if (method === "getState") return hostState;
      if (method === "getUsageReport") return usageReport;
      return { accepted: true };
    },
    (listener) => {
      eventListener = listener;
      return () => {
        eventListener = undefined;
      };
    },
    async () => preferences,
    async (patch) => {
      preferences = { ...preferences, ...patch };
      return preferences;
    },
  );

  expect(api.backend).toBe("windows");
  expect(Object.getPrototypeOf(api)).toBe(Object.prototype);
  expect(Object.prototype.hasOwnProperty.call(api, "backend")).toBe(true);
  const state = await api.getState();
  expect(state.themeMode).toBe("light");
  expect(state.enableTransparency).toBe(false);
  expect(state.composerDraft).toBe("");
  expect(state.composerAttachments).toEqual([]);

  await api.updateComposerDraft("Mac-only draft", {
    workspaceId: "workspace",
    sessionId: "thread",
  });
  expect((await api.getState()).composerDraft).toBe("Mac-only draft");
  await api.submitComposer("Send this to Windows");
  expect(invocations).toContainEqual({ method: "sendText", args: ["Send this to Windows"] });
  expect((await api.getState()).composerDraft).toBe("");

  const archiveTarget = { workspaceId: "windows-workspace", sessionId: "thread-archive" };
  await api.archiveSession(archiveTarget);
  await api.unarchiveSession(archiveTarget);
  expect(invocations.slice(-2)).toEqual([
    { method: "archiveSession", args: [archiveTarget] },
    { method: "unarchiveSession", args: [archiveTarget] },
  ]);

  await api.setThreadGrouping("time");
  await api.loadWorkspaceRuntime("windows-workspace", { refresh: true });
  expect(invocations.slice(-2)).toEqual([
    { method: "setThreadGrouping", args: ["time"] },
    { method: "loadWorkspaceRuntime", args: ["windows-workspace", { refresh: true }] },
  ]);

  const stateChanges: string[] = [];
  api.onStateChanged((next) => stateChanges.push(`${next.themeMode}:${next.enableTransparency}`));
  eventListener?.({ type: "stateChanged", state: hostState });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(stateChanges).toEqual(["light:false"]);
  expect(api.readClipboardImage()).toEqual({ kind: "none" });
  await expect(api.getUsageReport()).resolves.toEqual(usageReport);
  expect(invocations[invocations.length - 1]).toEqual({
    method: "getUsageReport",
    args: [],
  });
});

test("remote client sends usage metadata reads to Windows and returns their real results", async () => {
  const invocations: Array<{ method: RemoteDesktopMethod; args: readonly unknown[] }> = [];
  const signIns = [{ id: "openai", name: "OpenAI", state: "ok" as const }];
  const accountStates = [{ id: "claude-code-account-1", state: "ready" as const }];
  const accountLimits = [
    {
      id: "openai",
      name: "OpenAI",
      windows: [{ label: "Weekly", usedPercent: 12 }],
      asOf: 1_792_570_000_000,
    },
  ];
  const api = createRemoteDesktopClientApi(
    {
      getSignIns: async () => [],
      getAccountStates: async () => [],
      getAccountLimits: async () => [],
    } as unknown as PiDesktopApi,
    async (method, args) => {
      invocations.push({ method, args });
      if (method === "getSignIns") return signIns;
      if (method === "getAccountStates") return accountStates;
      if (method === "getAccountLimits") return accountLimits;
      return createEmptyDesktopAppState();
    },
    () => () => undefined,
    async () => ({ enableTransparency: false, themeMode: "light", themePresetId: "default" }),
    async () => ({ enableTransparency: false, themeMode: "light", themePresetId: "default" }),
  );

  await expect(api.getSignIns()).resolves.toEqual(signIns);
  await expect(api.getAccountStates()).resolves.toEqual(accountStates);
  await expect(api.getAccountLimits()).resolves.toEqual(accountLimits);
  await expect(api.getAccountLimits({ cachedOnly: true })).resolves.toEqual(accountLimits);
  expect(invocations).toEqual([
    { method: "getSignIns", args: [] },
    { method: "getAccountStates", args: [] },
    { method: "getAccountLimits", args: [] },
    { method: "getAccountLimits", args: [{ cachedOnly: true }] },
  ]);
});

test("remote folder adapters keep device identity on every Windows and Mac operation", async () => {
  const invocations: Array<{ method: RemoteDesktopMethod; args: readonly unknown[] }> = [];
  const listing = {
    rootId: "D:\\Pi\\projects",
    rootLabel: "Projects",
    relativePath: "",
    folders: [],
    truncated: false,
  };
  const api = createRemoteDesktopClientApi(
    { getState: async () => createEmptyDesktopAppState() } as unknown as PiDesktopApi,
    async (method, args) => {
      invocations.push({ method, args });
      if (method === "listWorkspaceFolderRoots") return [];
      if (method === "listWorkspaceFolders") return listing;
      if (method === "addWorkspaceFolder") return { device: "mac" };
      if (method === "createWorkspaceFolder") return { device: "mac", relativePath: "New" };
      return createEmptyDesktopAppState();
    },
    () => () => undefined,
    async () => ({ enableTransparency: false, themeMode: "light", themePresetId: "default" }),
    async () => ({ enableTransparency: false, themeMode: "light", themePresetId: "default" }),
  );

  const folders = api.workspaceFolders!;
  await folders.windows.listRoots();
  await folders.windows.list("D:\\Pi\\projects");
  await folders.windows.list("D:\\Pi\\projects", "NextSemis");
  await folders.windows.open("D:\\Pi\\projects", "NextSemis");
  await folders.mac!.listRoots();
  await folders.mac!.list("uniDocuments", "Courses");
  await folders.mac!.open("uniDocuments", "Courses");
  await folders.mac!.create("uniDocuments", "Courses", "New");

  expect(invocations).toEqual([
    { method: "listWorkspaceFolderRoots", args: ["windows"] },
    { method: "listWorkspaceFolders", args: ["windows", "D:\\Pi\\projects"] },
    { method: "listWorkspaceFolders", args: ["windows", "D:\\Pi\\projects", "NextSemis"] },
    { method: "addWorkspaceFolder", args: ["windows", "D:\\Pi\\projects", "NextSemis"] },
    { method: "listWorkspaceFolderRoots", args: ["mac"] },
    { method: "listWorkspaceFolders", args: ["mac", "uniDocuments", "Courses"] },
    { method: "addWorkspaceFolder", args: ["mac", "uniDocuments", "Courses"] },
    {
      method: "createWorkspaceFolder",
      args: ["mac", "uniDocuments", "Courses", "New"],
    },
  ]);
});

test("remote client routes active-view changes through the passive Windows view", async () => {
  const preferences: RemoteDesktopClientPreferences = {
    enableTransparency: false,
    themeMode: "light",
    themePresetId: "default",
  };
  const projectedState = {
    ...createEmptyDesktopAppState(),
    activeView: "skills" as const,
  };
  const invocations: Array<{ method: RemoteDesktopMethod; args: readonly unknown[] }> = [];
  let localSetActiveViewCalls = 0;
  const api = createRemoteDesktopClientApi(
    {
      setActiveView: async () => {
        localSetActiveViewCalls += 1;
        return createEmptyDesktopAppState();
      },
    } as unknown as PiDesktopApi,
    async (method, args) => {
      invocations.push({ method, args });
      return projectedState;
    },
    () => () => undefined,
    async () => preferences,
    async () => preferences,
  );

  expect(isRemoteDesktopPiMethod("setActiveView")).toBe(true);
  expect(isRemoteDesktopMethod("setActiveView")).toBe(true);
  expect(validateRemoteDesktopInvocation("setActiveView", ["skills"], new Set())).toEqual({
    method: "setActiveView",
    args: ["skills"],
  });
  expect(() => validateRemoteDesktopInvocation("setActiveView", ["providers"], new Set())).toThrow(
    "App view is invalid.",
  );
  await expect(api.setActiveView("skills")).resolves.toMatchObject({
    activeView: "skills",
    themeMode: "light",
  });
  expect(invocations).toEqual([{ method: "setActiveView", args: ["skills"] }]);
  expect(localSetActiveViewCalls).toBe(0);
});
