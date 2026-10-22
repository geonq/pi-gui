import type { RemoteBrokerRendererBridge, RemoteBrokerRequest } from "./remote-desktop-protocol";
import type { PiDesktopApi } from "../../contracts/ipc";
import type { WorkspaceFolderDevice } from "../../contracts/workspace-folders";

declare global {
  interface RemoteBrokerWindow {
    __piRemoteBroker?: RemoteBrokerRendererBridge;
    piApp?: PiDesktopApi;
  }
}

const brokerWindow = globalThis as unknown as RemoteBrokerWindow;
const api = brokerWindow.piApp;
const bridge = brokerWindow.__piRemoteBroker;

if (!api || !bridge) {
  throw new Error("The remote broker preload is unavailable.");
}

api.onStateChanged((state) => bridge.publish({ type: "stateChanged", state }));
api.onSelectedTranscriptChanged((transcript) =>
  bridge.publish({ type: "selectedTranscriptChanged", transcript }),
);

bridge.onRequest((request) => {
  void executeRequest(api, bridge, request).catch(() => undefined);
});
bridge.ready();

async function executeRequest(
  desktopApi: PiDesktopApi,
  broker: RemoteBrokerRendererBridge,
  request: RemoteBrokerRequest,
): Promise<void> {
  try {
    if (
      request.method === "listWorkspaceFolderRoots" ||
      request.method === "listWorkspaceFolders" ||
      request.method === "addWorkspaceFolder" ||
      request.method === "createWorkspaceFolder"
    ) {
      const [rawDevice, rootId, relativePath, name] = request.args;
      if (rawDevice !== "windows" && rawDevice !== "mac") {
        throw new TypeError("Folder device is invalid.");
      }
      const adapter = desktopApi.workspaceFolders?.[rawDevice as WorkspaceFolderDevice];
      if (!adapter) throw new Error("The selected folder browser is unavailable.");
      let value: unknown;
      if (request.method === "listWorkspaceFolderRoots") {
        value = await adapter.listRoots();
      } else if (request.method === "listWorkspaceFolders") {
        if (typeof rootId !== "string") throw new TypeError("Folder root is invalid.");
        value = await adapter.list(rootId, typeof relativePath === "string" ? relativePath : "");
      } else if (request.method === "addWorkspaceFolder") {
        if (typeof rootId !== "string" || typeof relativePath !== "string") {
          throw new TypeError("Folder target is invalid.");
        }
        value = await adapter.open(rootId, relativePath);
      } else {
        if (
          typeof rootId !== "string" ||
          typeof relativePath !== "string" ||
          typeof name !== "string"
        ) {
          throw new TypeError("New folder target is invalid.");
        }
        value = await adapter.create(rootId, relativePath, name);
      }
      broker.respond({ requestId: request.requestId, ok: true, value });
      return;
    }
    const method = desktopApi[request.method] as (...args: unknown[]) => Promise<unknown>;
    const value = await method.apply(desktopApi, [...request.args]);
    broker.respond({ requestId: request.requestId, ok: true, value });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Remote operation failed.";
    broker.respond({ requestId: request.requestId, ok: false, error: message.slice(0, 1_024) });
  }
}
