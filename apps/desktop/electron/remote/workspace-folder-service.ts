import type { DesktopAppState } from "../../contracts/desktop-state";
import type {
  WorkspaceFolderAdapters,
  WorkspaceFolderListing,
  WorkspaceFolderOpenResult,
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
  /** Local folder holding the stand-ins for Mac folders opened as Pi projects. */
  readonly macProjectsPath?: string;
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
  const macProjects = options.macProjectsPath
    ? createRemoteWorkspaceFolders(new Map([["macProjects", options.macProjectsPath]]))
    : undefined;
  const macAdapter = options.mac;
  // The host Mac module answers a project folder with the path of its local stand-in; register
  // that path as a workspace, and only when it is one of the Mac project stand-ins.
  const mac: WorkspaceFolderAdapters["mac"] = macAdapter && {
    listRoots: () => macAdapter.listRoots(),
    list: (rootId, relativePath) => macAdapter.list(rootId, relativePath),
    create: (rootId, parentRelativePath, name) =>
      macAdapter.create(rootId, parentRelativePath, name),
    async open(rootId, relativePath) {
      const opened = (await macAdapter.open(rootId, relativePath)) as WorkspaceFolderOpenResult & {
        readonly projectPath?: unknown;
      };
      if (opened.device !== "mac") throw new Error("Mac folder adapter result is invalid.");
      if (opened.projectPath === undefined) {
        return opened.workspaceId
          ? { device: "mac", workspaceId: opened.workspaceId }
          : { device: "mac" };
      }
      if (
        typeof opened.projectPath !== "string" ||
        !macProjects ||
        !(await macProjects.contains("macProjects", opened.projectPath))
      ) {
        throw new RemoteWorkspaceFolderError(
          "INVALID_PATH",
          "The Mac project folder is outside its authorized root.",
        );
      }
      const state = await options.addWorkspacePath(opened.projectPath);
      const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
      if (!workspace) throw new Error("The Mac project could not be registered.");
      return { device: "mac", workspaceId: workspace.id, state };
    },
  };
  return {
    adapters: {
      windows,
      ...(mac ? { mac } : {}),
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
