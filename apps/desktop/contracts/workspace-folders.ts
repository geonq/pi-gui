import type { DesktopAppState } from "./desktop-state";

export type WorkspaceFolderDevice = "windows" | "mac";

export interface WorkspaceFolderRoot {
  readonly id: string;
  readonly label: string;
  /** A canonical project ID, when this exact root maps to an existing project. */
  readonly workspaceId?: string;
  readonly canCreate: boolean;
}

export interface WorkspaceFolderEntry {
  readonly name: string;
  /** Slash-separated and relative to the selected root. */
  readonly relativePath: string;
}

export interface WorkspaceFolderListing {
  readonly rootId: string;
  readonly rootLabel: string;
  readonly relativePath: string;
  readonly parentRelativePath?: string;
  readonly folders: readonly WorkspaceFolderEntry[];
  readonly truncated: boolean;
}

export type WorkspaceFolderOpenResult =
  | {
      readonly device: "windows";
      readonly workspaceId: string;
      readonly state: DesktopAppState;
    }
  | {
      readonly device: "mac";
      readonly workspaceId?: string;
    };

export type WorkspaceFolderCreateResult =
  | {
      readonly device: "windows";
      readonly workspaceId: string;
      readonly relativePath: string;
      readonly state: DesktopAppState;
    }
  | {
      readonly device: "mac";
      readonly relativePath: string;
    };

export interface WorkspaceFolderAdapter {
  listRoots(): Promise<readonly WorkspaceFolderRoot[]>;
  list(rootId: string, relativePath?: string): Promise<WorkspaceFolderListing>;
  open(rootId: string, relativePath: string): Promise<WorkspaceFolderOpenResult>;
  create(
    rootId: string,
    parentRelativePath: string,
    name: string,
  ): Promise<WorkspaceFolderCreateResult>;
}

export interface WorkspaceFolderAdapters {
  readonly windows: WorkspaceFolderAdapter;
  readonly mac?: WorkspaceFolderAdapter;
}
