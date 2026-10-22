import type { PiDesktopApi } from "../../contracts/ipc";
import type {
  AppView,
  DesktopAppState,
  SelectedTranscriptRecord,
  ThreadGrouping,
} from "../../contracts/desktop-state";
import type {
  WorkspaceFolderAdapters,
  WorkspaceFolderCreateResult,
  WorkspaceFolderListing,
  WorkspaceFolderOpenResult,
  WorkspaceFolderRoot,
} from "../../contracts/workspace-folders";
import {
  isRemoteDesktopMethod,
  remoteClientIpc,
  type RemoteDesktopEvent,
  type RemoteDesktopMethod,
} from "./remote-desktop-protocol";
import type {
  RemoteDesktopClientPreferences,
  RemoteDesktopClientPreferencesPatch,
} from "./remote-desktop-client-preferences";

type InvokeRemote = (method: RemoteDesktopMethod, args: readonly unknown[]) => Promise<unknown>;
type SubscribeRemote = (listener: (event: RemoteDesktopEvent) => void) => () => void;
type GetLocalPreferences = () => Promise<RemoteDesktopClientPreferences>;
type SetLocalPreferences = (
  patch: RemoteDesktopClientPreferencesPatch,
) => Promise<RemoteDesktopClientPreferences>;

const REMOTE_METHODS = new Set<PropertyKey>([
  "getState",
  "getSelectedTranscript",
  "getSignIns",
  "getAccountStates",
  "getAccountLimits",
  "getUsageReport",
  "loadWorkspaceRuntime",
  "setActiveView",
  "selectWorkspace",
  "selectSession",
  "createSession",
  "startThread",
  "archiveSession",
  "unarchiveSession",
  "cancelCurrentRun",
  "setSessionModel",
  "setDefaultModel",
  "setSessionThinkingLevel",
  "setDefaultThinkingLevel",
  "setThreadGrouping",
  "listWorkspaceFiles",
  "readWorkspaceFile",
]);

const LOCAL_METHODS = new Set<PropertyKey>([
  "ping",
  "getThemeMode",
  "getResolvedTheme",
  "onThemeChanged",
  "onWindowFocused",
  "toggleWindowMaximize",
  "openExternal",
  "relaunchApplication",
  "getPathForFile",
  "readClipboardImage",
  "onPendingComposerDraftFlush",
  "persistComposerDraft",
  "updateComposerDraft",
]);

/** Reuse the existing typed PiDesktopApi surface while rejecting unimplemented cross-host calls. */
export function createRemoteDesktopClientApi(
  localApi: PiDesktopApi,
  invokeRemote: InvokeRemote,
  subscribeRemote: SubscribeRemote,
  getLocalPreferences: GetLocalPreferences,
  setLocalPreferences: SetLocalPreferences,
): PiDesktopApi {
  let localDraft = "";
  let lastState: DesktopAppState | null = null;
  let localPreferences: RemoteDesktopClientPreferences | undefined;
  const preferencesReady = getLocalPreferences().then((preferences) => {
    localPreferences = preferences;
    return preferences;
  });
  const overlayDraft = (state: DesktopAppState): DesktopAppState => ({
    ...state,
    composerDraft: localDraft,
    composerDraftSyncSource: "state",
    composerAttachments: [],
    editingQueuedMessageId: undefined,
  });
  const overlayLocalPreferences = async (state: DesktopAppState) => {
    const preferences = localPreferences ?? (await preferencesReady);
    return overlayDraft({ ...state, ...preferences });
  };
  const getState = async (): Promise<DesktopAppState> => {
    const [state] = await Promise.all([invokeRemote("getState", []), preferencesReady]);
    lastState = await overlayLocalPreferences(state as DesktopAppState);
    return lastState;
  };
  const runState = async (
    method: RemoteDesktopMethod,
    args: readonly unknown[],
  ): Promise<DesktopAppState> => {
    const [state] = await Promise.all([invokeRemote(method, args), preferencesReady]);
    lastState = await overlayLocalPreferences(state as DesktopAppState);
    return lastState;
  };
  const updatePreferences = async (
    patch: RemoteDesktopClientPreferencesPatch,
  ): Promise<DesktopAppState> => {
    localPreferences = await setLocalPreferences(patch);
    if (!lastState) return getState();
    lastState = overlayDraft({ ...lastState, ...localPreferences });
    return lastState;
  };
  const remoteApi = new Proxy(localApi as PiDesktopApi & { [key: string]: unknown }, {
    get(target, property, receiver) {
      if (property === "backend") return "windows";
      if (property === "onStateChanged") {
        return (listener: (state: DesktopAppState) => void) =>
          subscribeRemote((event) => {
            if (event.type === "stateChanged") {
              void overlayLocalPreferences(event.state)
                .then((state) => {
                  lastState = state;
                  listener(state);
                })
                .catch(() => undefined);
            }
          });
      }
      if (property === "onSelectedTranscriptChanged") {
        return (listener: (record: SelectedTranscriptRecord | null) => void) =>
          subscribeRemote((event) => {
            if (event.type === "selectedTranscriptChanged") listener(event.transcript);
          });
      }
      if (REMOTE_METHODS.has(property)) {
        switch (property) {
          case "getState":
            return getState;
          case "getSelectedTranscript":
            return () => invokeRemote("getSelectedTranscript", []);
          case "getSignIns":
            return () => invokeRemote("getSignIns", []);
          case "getAccountStates":
            return () => invokeRemote("getAccountStates", []);
          case "getAccountLimits":
            return (options?: { readonly cachedOnly?: boolean }) =>
              invokeRemote("getAccountLimits", options === undefined ? [] : [options]);
          case "getUsageReport":
            return () => invokeRemote("getUsageReport", []);
          case "selectWorkspace":
            return (workspaceId: string) => runState("selectWorkspace", [workspaceId]);
          case "selectSession":
            return (target: unknown) => runState("selectSession", [target]);
          case "createSession":
            return (input: unknown) => runState("createSession", [input]);
          case "startThread":
            return (input: unknown) => runState("startThread", [input]);
          case "archiveSession":
          case "unarchiveSession":
            return (target: unknown) => runState(property, [target]);
          case "cancelCurrentRun":
            return () => runState("cancelCurrentRun", []);
          case "setSessionModel":
            return (...args: unknown[]) => runState("setSessionModel", args);
          case "setDefaultModel":
            return (...args: unknown[]) => runState("setDefaultModel", args);
          case "setSessionThinkingLevel":
            return (...args: unknown[]) => runState("setSessionThinkingLevel", args);
          case "setDefaultThinkingLevel":
            return (...args: unknown[]) => runState("setDefaultThinkingLevel", args);
          case "setThreadGrouping":
            return (grouping: ThreadGrouping) => runState("setThreadGrouping", [grouping]);
          case "loadWorkspaceRuntime":
            return (workspaceId: string, options?: { readonly refresh?: boolean }) =>
              runState(
                "loadWorkspaceRuntime",
                options === undefined ? [workspaceId] : [workspaceId, options],
              );
          case "setActiveView":
            return (view: AppView) => runState("setActiveView", [view]);
          case "listWorkspaceFiles":
            return (...args: unknown[]) => invokeRemote("listWorkspaceFiles", args);
          case "readWorkspaceFile":
            return (...args: unknown[]) => invokeRemote("readWorkspaceFile", args);
        }
      }
      if (property === "submitComposer") {
        return async (text: string, options?: { readonly deliverAs?: "steer" | "followUp" }) => {
          if (options?.deliverAs === "steer") {
            throw new Error("Steering a running Windows thread is not available from this client.");
          }
          await invokeRemote("sendText", [text]);
          localDraft = "";
          return getState();
        };
      }
      if (property === "setEnableTransparency") {
        return (enabled: boolean) => updatePreferences({ enableTransparency: enabled });
      }
      if (property === "setThemeMode") {
        return (themeMode: RemoteDesktopClientPreferences["themeMode"]) =>
          updatePreferences({ themeMode });
      }
      if (property === "setThemePresetId") {
        return (themePresetId: RemoteDesktopClientPreferences["themePresetId"]) =>
          updatePreferences({ themePresetId });
      }
      if (property === "updateComposerDraft") {
        return async (draft: string) => {
          localDraft = draft;
          if (!lastState) return getState();
          lastState = overlayDraft({
            ...lastState,
            composerDraftSyncNonce: lastState.composerDraftSyncNonce + 1,
          });
          return lastState;
        };
      }
      if (property === "persistComposerDraft") {
        return async (input: { readonly draft: string }) => {
          localDraft = input.draft;
        };
      }
      if (LOCAL_METHODS.has(property)) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        return value.bind(target) as (...args: unknown[]) => unknown;
      }
      if (typeof property === "string" && property.startsWith("on")) {
        return () => () => undefined;
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return async () => {
        throw new Error(
          `The ${String(property)} capability is not available in remote desktop mode.`,
        );
      };
    },
  });
  const workspaceFolders: WorkspaceFolderAdapters = {
    windows: createRemoteWorkspaceFolderAdapter("windows", invokeRemote, overlayLocalPreferences),
    mac: createRemoteWorkspaceFolderAdapter("mac", invokeRemote, overlayLocalPreferences),
  };
  return { ...remoteApi, backend: "windows", workspaceFolders };
}

function createRemoteWorkspaceFolderAdapter(
  device: "windows" | "mac",
  invokeRemote: InvokeRemote,
  overlayState: (state: DesktopAppState) => Promise<DesktopAppState>,
): NonNullable<PiDesktopApi["workspaceFolders"]>["windows"] {
  return {
    async listRoots() {
      return (await invokeRemote("listWorkspaceFolderRoots", [
        device,
      ])) as readonly WorkspaceFolderRoot[];
    },
    async list(rootId, relativePath) {
      const args = relativePath === undefined ? [device, rootId] : [device, rootId, relativePath];
      return (await invokeRemote("listWorkspaceFolders", args)) as WorkspaceFolderListing;
    },
    async open(rootId, relativePath) {
      const result = (await invokeRemote("addWorkspaceFolder", [device, rootId, relativePath])) as
        WorkspaceFolderOpenResult | undefined;
      if (result?.device === "windows") {
        return { ...result, state: await overlayState(result.state) };
      }
      return result as WorkspaceFolderOpenResult;
    },
    async create(rootId, parentRelativePath, name) {
      const result = (await invokeRemote("createWorkspaceFolder", [
        device,
        rootId,
        parentRelativePath,
        name,
      ])) as WorkspaceFolderCreateResult;
      if (result.device === "windows") {
        return { ...result, state: await overlayState(result.state) };
      }
      return result;
    },
  };
}

export function remoteClientInvocationFromIpc(value: unknown): {
  readonly method: RemoteDesktopMethod;
  readonly args: readonly unknown[];
} {
  if (!isRecord(value) || typeof value.method !== "string" || !Array.isArray(value.args)) {
    throw new TypeError("Remote desktop invocation is invalid.");
  }
  const method = value.method as RemoteDesktopMethod;
  if (!isRemoteDesktopMethod(method)) {
    throw new TypeError("Remote desktop method is not available.");
  }
  return { method, args: value.args };
}

export const remoteDesktopClientPreloadChannels = {
  invoke: remoteClientIpc.invoke,
  stateChanged: remoteClientIpc.stateChanged,
  selectedTranscriptChanged: remoteClientIpc.selectedTranscriptChanged,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
