import type {
  WorkspaceFolderAdapters,
  WorkspaceFolderDevice,
} from "../../contracts/workspace-folders";
import { desktopIpc } from "../../contracts/ipc";
import { mainFrameArgsHandler } from "../ipc/main-frame-ipc";
import type { WindowOwner } from "../windows/window-owner";
import { expectOptionalWorkspaceFolderListingPath } from "./workspace-folder-ipc-validation";

export function registerWorkspaceFolderIpc(
  windows: WindowOwner,
  adapters: WorkspaceFolderAdapters,
): void {
  const handle = mainFrameArgsHandler(windows);
  handle(desktopIpc.listWorkspaceFolderRoots, (_request, rawDevice) => {
    const adapter = getAdapter(adapters, rawDevice);
    return adapter?.listRoots() ?? [];
  });
  handle(desktopIpc.listWorkspaceFolders, (_request, rawDevice, rawRootId, rawRelativePath) => {
    const adapter = requireAdapter(adapters, rawDevice);
    return adapter.list(
      expectString(rawRootId, "rootId"),
      expectOptionalWorkspaceFolderListingPath(rawRelativePath),
    );
  });
  handle(
    desktopIpc.openWorkspaceFolder,
    async ({ window }, rawDevice, rawRootId, rawRelativePath) => {
      const adapter = requireAdapter(adapters, rawDevice);
      const rootId = expectString(rawRootId, "rootId");
      const relativePath = expectRelativePath(rawRelativePath);
      if (rawDevice === "windows") {
        return windows.runStateResultAction(window, async () => {
          const result = await adapters.windows.open(rootId, relativePath);
          if (result.device !== "windows")
            throw new Error("Windows folder adapter result is invalid.");
          return result;
        });
      }
      const result = await adapter.open(rootId, relativePath);
      if (result.device !== "mac") throw new Error("Mac folder adapter result is invalid.");
      return result;
    },
  );
  handle(
    desktopIpc.createWorkspaceFolder,
    async ({ window }, rawDevice, rawRootId, rawParentRelativePath, rawName) => {
      const adapter = requireAdapter(adapters, rawDevice);
      const rootId = expectString(rawRootId, "rootId");
      const parentRelativePath = expectRelativePath(rawParentRelativePath);
      const name = expectString(rawName, "name");
      if (rawDevice === "windows") {
        return windows.runStateResultAction(window, async () => {
          const result = await adapters.windows.create(rootId, parentRelativePath, name);
          if (result.device !== "windows")
            throw new Error("Windows folder adapter result is invalid.");
          return result;
        });
      }
      const result = await adapter.create(rootId, parentRelativePath, name);
      if (result.device !== "mac") throw new Error("Mac folder adapter result is invalid.");
      return result;
    },
  );
}

function getAdapter(adapters: WorkspaceFolderAdapters, value: unknown) {
  if (value !== "windows" && value !== "mac") throw new TypeError("Folder device is invalid.");
  return adapters[value];
}

function requireAdapter(adapters: WorkspaceFolderAdapters, value: unknown) {
  const adapter = getAdapter(adapters, value);
  if (!adapter) throw new Error("The selected folder browser is unavailable.");
  return adapter;
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > 4_096) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function expectRelativePath(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4_096) {
    throw new TypeError("The relative folder path is invalid.");
  }
  return value;
}
