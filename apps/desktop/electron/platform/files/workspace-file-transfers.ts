import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  resolveExistingWorkspacePath,
  resolveWorkspacePath,
} from "./workspace-paths";

export const MAX_WORKSPACE_FILE_TRANSFER_BYTES = 64 * 1024 * 1024;

export type WorkspaceFileTransferErrorCode =
  | "WORKSPACE_UNAVAILABLE"
  | "INVALID_PATH"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TOO_LARGE"
  | "UNSAFE_FILE"
  | "IO_FAILURE";

export class WorkspaceFileTransferError extends Error {
  constructor(
    readonly code: WorkspaceFileTransferErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceFileTransferError";
  }
}

export interface WorkspaceFileTransferOptions {
  /** IDs and roots come from trusted workspace configuration, never from a request path. */
  readonly allowlistedWorkspaces: ReadonlyMap<string, string>;
}

export interface WorkspaceFileUploadInput {
  readonly workspaceId: string;
  /** Slash-separated path inside the workspace, including the original filename. */
  readonly relativePath: string;
  readonly originalName: string;
  readonly source: AsyncIterable<Uint8Array>;
  /** Replaces an existing regular file only when its current SHA-256 matches this value. */
  readonly expectedSha256?: string;
}

export interface WorkspaceFileDownloadInput {
  readonly workspaceId: string;
  readonly relativePath: string;
}

export interface WorkspaceFileTransferResult {
  readonly fileName: string;
  readonly relativePath: string;
  readonly sizeBytes: number;
}

export interface WorkspaceFileUploadResult extends WorkspaceFileTransferResult {
  readonly sha256: string;
}

export interface WorkspaceFileDownloadResult extends WorkspaceFileTransferResult {
  readonly contentType: "application/octet-stream";
  readonly stream: Readable;
}

const BLOCKED_DIRECTORY_NAMES = new Set([
  ".aws",
  ".azure",
  ".claude",
  ".codex",
  ".config",
  ".docker",
  ".git",
  ".gnupg",
  ".kube",
  ".ssh",
  "node_modules",
]);

const BLOCKED_FILE_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "credentials",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "known_hosts",
  "secrets",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "token",
  "token.json",
  "tokens.json",
]);

const BLOCKED_FILE_EXTENSIONS = [".key", ".p12", ".p8", ".pem", ".pfx"];

type ParsedRelativePath = {
  readonly fileName: string;
  readonly parentRelativePath: string;
  readonly segments: readonly string[];
};

export function createWorkspaceFileTransfers({
  allowlistedWorkspaces,
}: WorkspaceFileTransferOptions) {
  const workspaceRoots = new Map(allowlistedWorkspaces);
  const targetLocks = new Map<string, Promise<void>>();

  return {
    upload(input: WorkspaceFileUploadInput): Promise<WorkspaceFileUploadResult> {
      return uploadWorkspaceFile(workspaceRoots, targetLocks, input);
    },
    openDownload(input: WorkspaceFileDownloadInput): Promise<WorkspaceFileDownloadResult> {
      return openWorkspaceFileDownload(workspaceRoots, input);
    },
  };
}

async function uploadWorkspaceFile(
  workspaceRoots: ReadonlyMap<string, string>,
  targetLocks: Map<string, Promise<void>>,
  input: WorkspaceFileUploadInput,
): Promise<WorkspaceFileUploadResult> {
  const parsedPath = parseTransferPath(input.relativePath);
  if (input.originalName !== parsedPath.fileName || !isSafeFileName(input.originalName)) {
    throw transferError("INVALID_REQUEST", "The original filename must match the destination name.");
  }
  const expectedSha256 = input.expectedSha256?.toLowerCase();
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw transferError("INVALID_REQUEST", "The expected file hash is invalid.");
  }

  const workspaceRoot = await resolveAllowedWorkspaceRoot(workspaceRoots, input.workspaceId);
  const parentPath = await resolveExistingParent(workspaceRoot, parsedPath.parentRelativePath);
  const targetPath = path.join(parentPath, parsedPath.fileName);
  const lexicalTargetPath = resolveLexicalTarget(workspaceRoot, input.relativePath);

  if (expectedSha256 !== undefined) {
    const currentHash = await hashExistingTarget(workspaceRoot, input.relativePath, lexicalTargetPath);
    if (currentHash !== expectedSha256) {
      throw transferError("CONFLICT", "The workspace file changed before replacement.");
    }
  }

  const temporaryPath = path.join(parentPath, `.pi-transfer-${randomUUID()}.tmp`);
  let temporaryCreated = false;
  let sizeBytes = 0;
  const contentHash = createHash("sha256");

  try {
    const temporaryHandle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      for await (const chunk of input.source) {
        if (!(chunk instanceof Uint8Array)) {
          throw transferError("INVALID_REQUEST", "The upload stream contains invalid data.");
        }
        sizeBytes += chunk.byteLength;
        if (sizeBytes > MAX_WORKSPACE_FILE_TRANSFER_BYTES) {
          throw transferError("TOO_LARGE", "Files larger than 64 MiB cannot be transferred.");
        }
        contentHash.update(chunk);
        await writeAll(temporaryHandle, chunk);
      }
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }

    const currentParent = await resolveExistingParent(workspaceRoot, parsedPath.parentRelativePath);
    if (currentParent !== parentPath) {
      throw transferError("UNSAFE_FILE", "The workspace destination changed during upload.");
    }

    const finalize = async () => {
      if (expectedSha256 === undefined) {
        try {
          // link() is an atomic create-if-absent operation on the same volume.
          await link(temporaryPath, targetPath);
        } catch (error) {
          if (isAlreadyExists(error)) {
            throw transferError("CONFLICT", "A file already exists at the destination.", error);
          }
          throw error;
        }
        await unlink(temporaryPath);
        temporaryCreated = false;
        return;
      }

      const currentHash = await hashExistingTarget(workspaceRoot, input.relativePath, lexicalTargetPath);
      if (currentHash !== expectedSha256) {
        throw transferError("CONFLICT", "The workspace file changed before replacement.");
      }
      await rename(temporaryPath, targetPath);
      temporaryCreated = false;
    };

    if (expectedSha256 === undefined) {
      await finalize();
    } else {
      await withTargetLock(targetLocks, targetPath, finalize);
    }

    return {
      fileName: parsedPath.fileName,
      relativePath: input.relativePath,
      sizeBytes,
      sha256: contentHash.digest("hex"),
    };
  } catch (error) {
    throw toTransferError(error, "IO_FAILURE");
  } finally {
    if (temporaryCreated) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

async function openWorkspaceFileDownload(
  workspaceRoots: ReadonlyMap<string, string>,
  input: WorkspaceFileDownloadInput,
): Promise<WorkspaceFileDownloadResult> {
  const parsedPath = parseTransferPath(input.relativePath);
  const workspaceRoot = await resolveAllowedWorkspaceRoot(workspaceRoots, input.workspaceId);
  const lexicalTargetPath = resolveLexicalTarget(workspaceRoot, input.relativePath);
  const resolvedTargetPath = await resolveExistingTarget(workspaceRoot, input.relativePath);

  let handle: FileHandle | undefined;
  try {
    const lexicalStats = await lstat(lexicalTargetPath);
    if (lexicalStats.isSymbolicLink() || !lexicalStats.isFile() || lexicalStats.nlink > 1) {
      throw transferError("UNSAFE_FILE", "This workspace file is not eligible for transfer.");
    }

    handle = await openReadOnly(resolvedTargetPath);
    const openedStats = await handle.stat();
    if (!sameFileIdentity(lexicalStats, openedStats) || !openedStats.isFile() || openedStats.nlink > 1) {
      throw transferError("UNSAFE_FILE", "This workspace file changed during access.");
    }
    if (openedStats.size > MAX_WORKSPACE_FILE_TRANSFER_BYTES) {
      throw transferError("TOO_LARGE", "Files larger than 64 MiB cannot be transferred.");
    }

    const sizeBytes = openedStats.size;
    const stream =
      sizeBytes === 0
        ? Readable.from([])
        : handle.createReadStream({ autoClose: true, start: 0, end: sizeBytes - 1 });
    if (sizeBytes === 0) {
      await handle.close();
      handle = undefined;
    } else {
      handle = undefined;
    }
    return {
      fileName: parsedPath.fileName,
      relativePath: input.relativePath,
      sizeBytes,
      contentType: "application/octet-stream",
      stream,
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    throw toTransferError(error, "IO_FAILURE");
  }
}

async function resolveAllowedWorkspaceRoot(
  workspaceRoots: ReadonlyMap<string, string>,
  workspaceId: string,
): Promise<string> {
  const configuredPath = workspaceRoots.get(workspaceId);
  if (!configuredPath) {
    throw transferError("WORKSPACE_UNAVAILABLE", "This workspace is not available for file transfer.");
  }
  try {
    const workspaceRoot = await realpath(path.resolve(configuredPath));
    const rootStats = await stat(workspaceRoot);
    if (!rootStats.isDirectory()) {
      throw transferError("WORKSPACE_UNAVAILABLE", "This workspace is not available for file transfer.");
    }
    return workspaceRoot;
  } catch (error) {
    throw toTransferError(error, "WORKSPACE_UNAVAILABLE");
  }
}

async function resolveExistingParent(workspaceRoot: string, relativePath: string): Promise<string> {
  try {
    const parentPath = await resolveExistingWorkspacePath(workspaceRoot, relativePath || ".");
    const parentStats = await stat(parentPath);
    if (!parentStats.isDirectory()) {
      throw transferError("NOT_FOUND", "The workspace destination folder was not found.");
    }
    return parentPath;
  } catch (error) {
    throw toTransferError(error, "NOT_FOUND");
  }
}

async function resolveExistingTarget(workspaceRoot: string, relativePath: string): Promise<string> {
  try {
    return await resolveExistingWorkspacePath(workspaceRoot, relativePath);
  } catch (error) {
    throw toTransferError(error, "NOT_FOUND");
  }
}

function resolveLexicalTarget(workspaceRoot: string, relativePath: string): string {
  try {
    return resolveWorkspacePath(workspaceRoot, relativePath);
  } catch (error) {
    throw toTransferError(error, "INVALID_PATH");
  }
}

async function hashExistingTarget(
  workspaceRoot: string,
  relativePath: string,
  lexicalTargetPath: string,
): Promise<string> {
  const resolvedTargetPath = await resolveExistingTarget(workspaceRoot, relativePath);
  let handle: FileHandle | undefined;
  try {
    const lexicalStats = await lstat(lexicalTargetPath);
    if (lexicalStats.isSymbolicLink() || !lexicalStats.isFile() || lexicalStats.nlink > 1) {
      throw transferError("UNSAFE_FILE", "This workspace file is not eligible for replacement.");
    }

    handle = await openReadOnly(resolvedTargetPath);
    const openedStats = await handle.stat();
    if (!sameFileIdentity(lexicalStats, openedStats) || !openedStats.isFile() || openedStats.nlink > 1) {
      throw transferError("UNSAFE_FILE", "This workspace file changed during access.");
    }
    if (openedStats.size > MAX_WORKSPACE_FILE_TRANSFER_BYTES) {
      throw transferError("TOO_LARGE", "Files larger than 64 MiB cannot be transferred.");
    }

    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < openedStats.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, openedStats.size - position),
        position,
      );
      if (bytesRead === 0) {
        throw transferError("CONFLICT", "The workspace file changed during replacement.");
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const finalStats = await handle.stat();
    if (
      !sameFileIdentity(openedStats, finalStats) ||
      openedStats.size !== finalStats.size ||
      openedStats.mtimeMs !== finalStats.mtimeMs
    ) {
      throw transferError("CONFLICT", "The workspace file changed during replacement.");
    }
    return hash.digest("hex");
  } catch (error) {
    throw toTransferError(error, "IO_FAILURE");
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function openReadOnly(filePath: string): Promise<FileHandle> {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  try {
    return await open(filePath, constants.O_RDONLY | noFollow);
  } catch (error) {
    throw toTransferError(error, "IO_FAILURE");
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (bytesWritten === 0) {
      throw transferError("IO_FAILURE", "The workspace file could not be written.");
    }
    offset += bytesWritten;
  }
}

function parseTransferPath(relativePath: string): ParsedRelativePath {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.length > 4096 ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    /^[a-z]:/i.test(relativePath)
  ) {
    throw transferError("INVALID_PATH", "A safe relative workspace path is required.");
  }

  const segments = relativePath.split("/");
  if (
    segments.some((segment) => !isSafeFileName(segment)) ||
    isBlockedTransferPath(segments)
  ) {
    throw transferError("INVALID_PATH", "This path is not eligible for file transfer.");
  }

  return {
    fileName: segments.at(-1)!,
    parentRelativePath: segments.slice(0, -1).join("/"),
    segments,
  };
}

function isSafeFileName(fileName: string): boolean {
  if (
    fileName.length === 0 ||
    fileName === "." ||
    fileName === ".." ||
    /[\u0000-\u001f\u007f<>:"|?*\\/]/.test(fileName) ||
    /[. ]$/.test(fileName) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(fileName)
  ) {
    return false;
  }
  return true;
}

function isBlockedTransferPath(segments: readonly string[]): boolean {
  return segments.some((segment, index) => {
    const normalized = segment.toLocaleLowerCase("en-US");
    if (BLOCKED_DIRECTORY_NAMES.has(normalized)) return true;
    if (normalized === ".env" || normalized.startsWith(".env.")) return true;
    if (index < segments.length - 1) return false;
    return (
      BLOCKED_FILE_NAMES.has(normalized) ||
      /^service-account(?:[-_].*)?\.json$/.test(normalized) ||
      BLOCKED_FILE_EXTENSIONS.some((extension) => normalized.endsWith(extension))
    );
  });
}

async function withTargetLock<T>(
  locks: Map<string, Promise<void>>,
  targetPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = process.platform === "win32" ? targetPath.toLocaleLowerCase("en-US") : targetPath;
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  locks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

function sameFileIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function toTransferError(error: unknown, fallback: WorkspaceFileTransferErrorCode): WorkspaceFileTransferError {
  if (error instanceof WorkspaceFileTransferError) return error;
  if (error instanceof Error && error.message === "Path escapes workspace") {
    return transferError("UNSAFE_FILE", "This path is outside the allowed workspace.", error);
  }
  if (isNodeError(error)) {
    if (error.code === "ENOENT") {
      return transferError(fallback === "WORKSPACE_UNAVAILABLE" ? fallback : "NOT_FOUND", "The workspace file was not found.", error);
    }
    if (error.code === "EEXIST") {
      return transferError("CONFLICT", "A file already exists at the destination.", error);
    }
  }
  return transferError(fallback, "The workspace file operation failed.", error);
}

function transferError(
  code: WorkspaceFileTransferErrorCode,
  message: string,
  cause?: unknown,
): WorkspaceFileTransferError {
  return new WorkspaceFileTransferError(code, message, cause === undefined ? undefined : { cause });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
