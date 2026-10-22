import type { DesktopAppState } from "../../contracts/desktop-state";
import type {
  WorkspaceFolderAdapters,
  WorkspaceFolderListing,
  WorkspaceFolderRoot,
} from "../../contracts/workspace-folders";
import {
  createRemoteWorkspaceFolders,
  RemoteWorkspaceFolderError,
} from "./remote-workspace-folders";

export interface WindowsWorkspaceFolderRootConfig extends WorkspaceFolderRoot {
  readonly path: string;
}

export interface WorkspaceFolderService {
  readonly adapters: WorkspaceFolderAdapters;
  /** Kept in main-process scope for per-client authorization checks. */
  readonly windowsRootPaths: ReadonlyMap<string, string>;
}

export function createWorkspaceFolderService(options: {
  readonly windowsRoots: readonly WindowsWorkspaceFolderRootConfig[];
  readonly mac?: WorkspaceFolderAdapters["mac"];
  readonly addWorkspacePath: (path: string) => Promise<DesktopAppState>;
}): WorkspaceFolderService {
  const windowsRootPaths = new Map(options.windowsRoots.map((root) => [root.id, root.path]));
  if (windowsRootPaths.size !== options.windowsRoots.length) {
    throw new TypeError("Windows folder root IDs must be unique.");
  }
  const folders = createRemoteWorkspaceFolders(windowsRootPaths);
  const roots = new Map(options.windowsRoots.map((root) => [root.id, root]));
  const windows: NonNullable<WorkspaceFolderAdapters["windows"]> = {
    async listRoots(): Promise<readonly WorkspaceFolderRoot[]> {
      return options.windowsRoots.map(({ path: _path, ...root }) => root);
    },
    async list(rootId, relativePath): Promise<WorkspaceFolderListing> {
      const root = getRoot(rootId);
      return {
        rootId,
        rootLabel: root.label,
        ...(await folders.list(rootId, relativePath)),
      };
    },
    async open(rootId, relativePath) {
      const absolutePath = await folders.resolveExisting(rootId, relativePath);
      const state = await options.addWorkspacePath(absolutePath);
      const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
      if (!workspace || !(await folders.contains(rootId, workspace.path, true))) {
        throw new RemoteWorkspaceFolderError(
          "INVALID_PATH",
          "The selected folder is outside its authorized root.",
        );
      }
      return { device: "windows", workspaceId: workspace.id, state };
    },
    async create(rootId, parentRelativePath, name) {
      const root = getRoot(rootId);
      if (!root.canCreate) {
        throw new RemoteWorkspaceFolderError(
          "INVALID_PATH",
          "Folders cannot be created in this location.",
        );
      }
      const created = await folders.create(rootId, parentRelativePath, name);
      const state = await options.addWorkspacePath(created.absolutePath);
      const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
      if (!workspace || !(await folders.contains(rootId, workspace.path, true))) {
        throw new RemoteWorkspaceFolderError(
          "INVALID_PATH",
          "The created folder is outside its authorized root.",
        );
      }
      return {
        device: "windows",
        workspaceId: workspace.id,
        relativePath: created.relativePath,
        state,
      };
    },
  };
  return {
    adapters: {
      windows,
      ...(options.mac ? { mac: options.mac } : {}),
    },
    windowsRootPaths,
  };

  function getRoot(rootId: string): WindowsWorkspaceFolderRootConfig {
    const root = roots.get(rootId);
    if (!root) {
      throw new RemoteWorkspaceFolderError("ROOT_UNAVAILABLE", "This folder root is unavailable.");
    }
    return root;
  }
}
