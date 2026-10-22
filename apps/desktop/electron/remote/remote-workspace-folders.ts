import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { resolveExistingWorkspacePath } from "../platform/files/workspace-paths";

const MAX_RELATIVE_PATH_BYTES = 4_096;
const MAX_FOLDER_NAME_BYTES = 255;
const MAX_LISTED_FOLDERS = 500;
const HIDDEN_FOLDER_NAMES = new Set([
  "$recycle.bin",
  ".aws",
  ".codex",
  ".git",
  ".gnupg",
  ".ssh",
  "node_modules",
  "system volume information",
]);

export type RemoteWorkspaceFolderErrorCode =
  | "ROOT_UNAVAILABLE"
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IO_FAILURE";

export class RemoteWorkspaceFolderError extends Error {
  constructor(
    readonly code: RemoteWorkspaceFolderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RemoteWorkspaceFolderError";
  }
}

export interface RemoteWorkspaceFolderEntry {
  readonly name: string;
  /** Slash-separated and relative to the configured root. */
  readonly relativePath: string;
}

export interface RemoteWorkspaceFolderListing {
  readonly relativePath: string;
  readonly parentRelativePath?: string;
  readonly folders: readonly RemoteWorkspaceFolderEntry[];
  readonly truncated: boolean;
}

/** Root IDs and paths are supplied by trusted host configuration, never by a request path. */
export function createRemoteWorkspaceFolders(roots: ReadonlyMap<string, string>) {
  const configuredRoots = new Map(roots);

  return {
    list(rootId: string, relativePath = ""): Promise<RemoteWorkspaceFolderListing> {
      return listWorkspaceFolders(configuredRoots, rootId, relativePath);
    },
    resolveExisting(rootId: string, relativePath: string): Promise<string> {
      return resolveExistingWorkspaceFolder(configuredRoots, rootId, relativePath);
    },
    contains(rootId: string, candidatePath: string, includeRoot = false): Promise<boolean> {
      return isWorkspacePathInsideRoot(configuredRoots, rootId, candidatePath, includeRoot);
    },
    create(rootId: string, parentRelativePath: string, name: string): Promise<{
      readonly absolutePath: string;
      readonly relativePath: string;
    }> {
      return createWorkspaceFolder(configuredRoots, rootId, parentRelativePath, name);
    },
  };
}

async function listWorkspaceFolders(
  roots: ReadonlyMap<string, string>,
  rootId: string,
  rawRelativePath: string,
): Promise<RemoteWorkspaceFolderListing> {
  const relativePath = parseRelativeDirectoryPath(rawRelativePath);
  const rootPath = await resolveAllowedRoot(roots, rootId);
  const directoryPath = await resolveExistingDirectory(rootPath, relativePath);
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const folders: RemoteWorkspaceFolderEntry[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || isHiddenFolder(entry.name)) continue;
      const childRelativePath = joinRelativePath(relativePath, entry.name);
      try {
        const resolvedChild = await resolveExistingWorkspacePath(rootPath, childRelativePath);
        const childStats = await lstat(resolvedChild);
        if (childStats.isDirectory() && !childStats.isSymbolicLink()) {
          folders.push({ name: entry.name, relativePath: childRelativePath });
        }
      } catch {
        // A path that changed or escaped during enumeration is omitted.
      }
    }
    folders.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
    return {
      relativePath,
      ...(relativePath
        ? { parentRelativePath: parentRelativePath(relativePath) }
        : {}),
      folders: folders.slice(0, MAX_LISTED_FOLDERS),
      truncated: folders.length > MAX_LISTED_FOLDERS,
    };
  } catch (error) {
    throw toFolderError(error, "NOT_FOUND");
  }
}

async function resolveExistingWorkspaceFolder(
  roots: ReadonlyMap<string, string>,
  rootId: string,
  rawRelativePath: string,
): Promise<string> {
  const relativePath = parseRelativeDirectoryPath(rawRelativePath);
  const rootPath = await resolveAllowedRoot(roots, rootId);
  return resolveExistingDirectory(rootPath, relativePath);
}

async function createWorkspaceFolder(
  roots: ReadonlyMap<string, string>,
  rootId: string,
  rawParentRelativePath: string,
  rawName: string,
): Promise<{ readonly absolutePath: string; readonly relativePath: string }> {
  const parentRelativePath = parseRelativeDirectoryPath(rawParentRelativePath);
  const name = parseFolderName(rawName);
  const rootPath = await resolveAllowedRoot(roots, rootId);
  const parentPath = await resolveExistingDirectory(rootPath, parentRelativePath);
  const childRelativePath = joinRelativePath(parentRelativePath, name);
  const targetPath = path.join(parentPath, name);

  try {
    await mkdir(targetPath);
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw folderError("CONFLICT", "A folder already exists at this location.", error);
    }
    throw toFolderError(error, "IO_FAILURE");
  }

  try {
    const resolvedPath = await resolveExistingWorkspacePath(rootPath, childRelativePath);
    const childStats = await stat(resolvedPath);
    if (!childStats.isDirectory()) {
      throw folderError("NOT_FOUND", "The created folder is unavailable.");
    }
    return { absolutePath: resolvedPath, relativePath: childRelativePath };
  } catch (error) {
    throw toFolderError(error, "IO_FAILURE");
  }
}

async function isWorkspacePathInsideRoot(
  roots: ReadonlyMap<string, string>,
  rootId: string,
  candidatePath: string,
  includeRoot: boolean,
): Promise<boolean> {
  try {
    const rootPath = await resolveAllowedRoot(roots, rootId);
    const resolvedCandidate = await realpath(path.resolve(candidatePath));
    const relativePath = path.relative(rootPath, resolvedCandidate);
    if (!relativePath) return includeRoot;
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      return false;
    }
    await resolveExistingWorkspacePath(rootPath, relativePath.split(path.sep).join("/"));
    return true;
  } catch {
    return false;
  }
}

async function resolveAllowedRoot(roots: ReadonlyMap<string, string>, rootId: string): Promise<string> {
  const configuredPath = roots.get(rootId);
  if (!configuredPath) {
    throw folderError("ROOT_UNAVAILABLE", "This folder root is not authorized.");
  }
  try {
    const resolvedPath = await realpath(path.resolve(configuredPath));
    const rootStats = await stat(resolvedPath);
    if (!rootStats.isDirectory()) {
      throw folderError("ROOT_UNAVAILABLE", "This folder root is unavailable.");
    }
    return resolvedPath;
  } catch (error) {
    throw toFolderError(error, "ROOT_UNAVAILABLE");
  }
}

async function resolveExistingDirectory(rootPath: string, relativePath: string): Promise<string> {
  try {
    const resolvedPath = await resolveExistingWorkspacePath(rootPath, relativePath || ".");
    const targetStats = await stat(resolvedPath);
    if (!targetStats.isDirectory()) {
      throw folderError("NOT_FOUND", "The selected folder was not found.");
    }
    return resolvedPath;
  } catch (error) {
    throw toFolderError(error, "NOT_FOUND");
  }
}

function parseRelativeDirectoryPath(value: string): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_RELATIVE_PATH_BYTES ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[a-z]:/iu.test(value) ||
    value.includes("\0")
  ) {
    throw folderError("INVALID_PATH", "The folder path is invalid.");
  }
  if (value === "" || value === ".") return "";
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw folderError("INVALID_PATH", "The folder path is invalid.");
  }
  return segments.join("/");
}

function parseFolderName(value: string): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_FOLDER_NAME_BYTES ||
    value.trim() !== value ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    /[<>:"/\\|?*\u0000-\u001f]/u.test(value) ||
    /[ .]$/u.test(value) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
  ) {
    throw folderError("INVALID_PATH", "The folder name is invalid.");
  }
  return value;
}

function joinRelativePath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function parentRelativePath(relativePath: string): string {
  const separator = relativePath.lastIndexOf("/");
  return separator < 0 ? "" : relativePath.slice(0, separator);
}

function isHiddenFolder(name: string): boolean {
  return HIDDEN_FOLDER_NAMES.has(name.toLowerCase());
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}

function toFolderError(error: unknown, fallback: RemoteWorkspaceFolderErrorCode): RemoteWorkspaceFolderError {
  return error instanceof RemoteWorkspaceFolderError
    ? error
    : folderError(fallback, "The folder operation failed.", error);
}

function folderError(
  code: RemoteWorkspaceFolderErrorCode,
  message: string,
  cause?: unknown,
): RemoteWorkspaceFolderError {
  return new RemoteWorkspaceFolderError(
    code,
    message,
    cause instanceof Error ? { cause } : undefined,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
