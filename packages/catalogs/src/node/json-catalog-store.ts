import {
  createEmptyState,
  parseState,
  cloneWorkspaceEntry,
  cloneSessionEntry,
  cloneWorktreeEntry,
  type CatalogFileState,
} from "./catalog-codec.js";
import { isMissingFileError } from "./file-errors.js";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { writeJsonFileAtomic } from "./atomic-write.js";
import type {
  SessionFileCatalogStorage,
  SessionCatalogEntry,
  SessionCatalogSnapshot,
  SessionRef,
  WorkspaceCatalogEntry,
  WorkspaceCatalogSnapshot,
  WorkspaceId,
  WorktreeCatalogEntry,
  WorktreeCatalogSnapshot,
  WorktreeId,
  WorkspaceSessionSyncReplacement,
} from "../index.js";
import { sessionKey } from "@pi-gui/session-driver";

interface CatalogFileCoordinator {
  mutationQueue: Promise<void>;
  generation: number;
}

const coordinatorsByPath = new Map<string, CatalogFileCoordinator>();

export interface JsonCatalogStoreOptions {
  readonly catalogFilePath?: string;
}

export class JsonCatalogStore implements SessionFileCatalogStorage {
  private readonly filePath: string;
  private readonly coordinator: CatalogFileCoordinator;
  private state: CatalogFileState | undefined;
  private stateGeneration = -1;
  private loadPromise: Promise<CatalogFileState> | undefined;
  private loadGeneration = -1;

  constructor(options: JsonCatalogStoreOptions = {}) {
    this.filePath = options.catalogFilePath
      ? resolve(options.catalogFilePath)
      : defaultCatalogFilePath();
    this.coordinator = coordinatorForPath(this.filePath);
  }

  readonly workspaces = {
    listWorkspaces: async (): Promise<WorkspaceCatalogSnapshot> => {
      const state = await this.getState();
      return {
        workspaces: [...state.workspaces].sort(compareWorkspaceEntries).map(cloneWorkspaceEntry),
      };
    },
    getWorkspace: async (workspaceId: WorkspaceId): Promise<WorkspaceCatalogEntry | undefined> => {
      const state = await this.getState();
      const entry = state.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
      return entry ? cloneWorkspaceEntry(entry) : undefined;
    },
    upsertWorkspace: async (entry: WorkspaceCatalogEntry): Promise<void> => {
      await this.mutateState((state) => {
        const index = state.workspaces.findIndex(
          (workspace) => workspace.workspaceId === entry.workspaceId,
        );
        const next = cloneWorkspaceEntry(entry);
        if (index >= 0) {
          state.workspaces[index] = next;
        } else {
          state.workspaces.push(next);
        }
      });
    },
    deleteWorkspace: async (workspaceId: WorkspaceId): Promise<void> => {
      await this.mutateState((state) => {
        state.workspaces = state.workspaces.filter(
          (workspace) => workspace.workspaceId !== workspaceId,
        );
        state.sessions = state.sessions.filter((session) => session.workspaceId !== workspaceId);
        state.worktrees = state.worktrees.filter(
          (worktree) => !(worktree.workspaceId === workspaceId && worktree.kind === "primary"),
        );
        for (const key of Object.keys(state.sessionFiles)) {
          if (key.startsWith(`${workspaceId}:`)) {
            delete state.sessionFiles[key];
          }
        }
      });
    },
  };

  readonly worktrees = {
    listWorktrees: async (workspaceId?: WorkspaceId): Promise<WorktreeCatalogSnapshot> => {
      const state = await this.getState();
      return {
        worktrees: [...state.worktrees]
          .filter((entry) => (workspaceId ? entry.workspaceId === workspaceId : true))
          .sort(compareWorktreeEntries)
          .map(cloneWorktreeEntry),
      };
    },
    getWorktree: async (worktreeId: WorktreeId): Promise<WorktreeCatalogEntry | undefined> => {
      const state = await this.getState();
      const entry = state.worktrees.find((worktree) => worktree.worktreeId === worktreeId);
      return entry ? cloneWorktreeEntry(entry) : undefined;
    },
    upsertWorktree: async (entry: WorktreeCatalogEntry): Promise<void> => {
      await this.mutateState((state) => {
        const index = state.worktrees.findIndex(
          (worktree) => worktree.worktreeId === entry.worktreeId,
        );
        const next = cloneWorktreeEntry(entry);
        if (index >= 0) {
          state.worktrees[index] = next;
        } else {
          state.worktrees.push(next);
        }
      });
    },
    deleteWorktree: async (worktreeId: WorktreeId): Promise<void> => {
      await this.mutateState((state) => {
        state.worktrees = state.worktrees.filter((worktree) => worktree.worktreeId !== worktreeId);
      });
    },
    replaceWorkspaceWorktrees: async (
      workspaceId: WorkspaceId,
      entries: readonly WorktreeCatalogEntry[],
    ): Promise<void> => {
      await this.mutateState((state) => {
        const nextEntries = entries.map(cloneWorktreeEntry);
        const existingEntries = state.worktrees
          .filter((worktree) => worktree.workspaceId === workspaceId)
          .sort(compareWorktreeEntries);
        if (areWorktreeListsEqual(existingEntries, nextEntries)) {
          return false;
        }

        state.worktrees = [
          ...state.worktrees.filter((worktree) => worktree.workspaceId !== workspaceId),
          ...nextEntries,
        ];
      });
    },
  };

  readonly sessions = {
    listSessions: async (workspaceId?: WorkspaceId): Promise<SessionCatalogSnapshot> => {
      const state = await this.getState();
      const sessions = state.sessions
        .filter((entry) => (workspaceId ? entry.workspaceId === workspaceId : true))
        .sort(compareSessionEntries)
        .map(cloneSessionEntry);
      return { sessions };
    },
    getSession: async (sessionRef: SessionRef): Promise<SessionCatalogEntry | undefined> => {
      const state = await this.getState();
      const entry = state.sessions.find(
        (session) => sessionKey(session.sessionRef) === sessionKey(sessionRef),
      );
      return entry ? cloneSessionEntry(entry) : undefined;
    },
    upsertSession: async (entry: SessionCatalogEntry): Promise<void> => {
      await this.mutateState((state) => {
        const index = state.sessions.findIndex(
          (session) => sessionKey(session.sessionRef) === sessionKey(entry.sessionRef),
        );
        // The driver persists a session on every agent event, mostly with nothing changed;
        // skipping those writes keeps fsyncs from delaying the events behind them.
        if (index >= 0 && areSessionEntriesEqual(state.sessions[index]!, entry)) {
          return false;
        }
        const next = cloneSessionEntry(entry);
        if (index >= 0) {
          state.sessions[index] = next;
        } else {
          state.sessions.push(next);
        }
      });
    },
    deleteSession: async (sessionRef: SessionRef): Promise<void> => {
      await this.mutateState((state) => {
        const key = sessionKey(sessionRef);
        state.sessions = state.sessions.filter((session) => sessionKey(session.sessionRef) !== key);
        delete state.sessionFiles[key];
      });
    },
  };

  async getSessionFile(sessionRef: SessionRef): Promise<string | undefined> {
    const state = await this.getState();
    return state.sessionFiles[sessionKey(sessionRef)];
  }

  async setSessionFile(sessionRef: SessionRef, sessionFile: string): Promise<void> {
    await this.mutateState((state) => {
      const key = sessionKey(sessionRef);
      if (state.sessionFiles[key] === sessionFile) return false;
      state.sessionFiles[key] = sessionFile;
    });
  }

  async deleteSessionFile(sessionRef: SessionRef): Promise<void> {
    await this.mutateState((state) => {
      delete state.sessionFiles[sessionKey(sessionRef)];
    });
  }

  async replaceWorkspaceSessions(
    workspaceId: WorkspaceId,
    entries: readonly SessionCatalogEntry[],
    sessionFiles: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.mutateState((state) => {
      const nextEntries = entries.map(cloneSessionEntry);
      const nextKeys = new Set(nextEntries.map((entry) => sessionKey(entry.sessionRef)));

      state.sessions = [
        ...state.sessions.filter((session) => session.workspaceId !== workspaceId),
        ...nextEntries,
      ];

      for (const key of Object.keys(state.sessionFiles)) {
        if (key.startsWith(`${workspaceId}:`) && !nextKeys.has(key)) {
          delete state.sessionFiles[key];
        }
      }

      for (const [key, filePath] of Object.entries(sessionFiles)) {
        state.sessionFiles[key] = filePath;
      }
    });
  }

  async replaceWorkspaceSyncBatch(
    newWorkspaces: readonly WorkspaceCatalogEntry[],
    replacements: readonly WorkspaceSessionSyncReplacement[],
  ): Promise<readonly SessionRef[]> {
    let removedSessionRefs: SessionRef[] = [];
    await this.mutateState((state) => {
      const nextWorkspaces = [...state.workspaces];
      for (const workspace of newWorkspaces) {
        if (nextWorkspaces.some((entry) => entry.workspaceId === workspace.workspaceId)) continue;
        nextWorkspaces.push({ ...cloneWorkspaceEntry(workspace), sortOrder: nextWorkspaces.length });
      }

      const nextEntriesByWorkspace = new Map<WorkspaceId, SessionCatalogEntry[]>();
      const removed = new Map<string, SessionRef>();
      for (const replacement of replacements) {
        const baselineByKey = new Map(
          replacement.baselineEntries.map((entry) => [sessionKey(entry.sessionRef), entry]),
        );
        const stagedByKey = new Map(
          replacement.entries.map((entry) => [sessionKey(entry.sessionRef), entry]),
        );
        const currentByKey = new Map(
          state.sessions
            .filter((entry) => entry.workspaceId === replacement.workspaceId)
            .map((entry) => [sessionKey(entry.sessionRef), entry]),
        );
        const finalByKey = new Map<string, SessionCatalogEntry>();
        const keys = new Set([
          ...baselineByKey.keys(),
          ...stagedByKey.keys(),
          ...currentByKey.keys(),
        ]);

        for (const key of keys) {
          const baseline = baselineByKey.get(key);
          const current = currentByKey.get(key);
          const staged = stagedByKey.get(key);
          const baselinePath =
            replacement.baselineSessionFiles[key] || baseline?.sessionFilePath;
          const currentPath = state.sessionFiles[key] || current?.sessionFilePath;
          const changedSinceScan =
            Boolean(current) &&
            (Boolean(baseline) && !areSessionEntriesEqual(current!, baseline!) ||
              currentPath !== baselinePath);
          if (baseline) {
            if (!current) continue;
            if (changedSinceScan) {
              finalByKey.set(key, current);
            } else if (staged) {
              finalByKey.set(key, staged);
            }
          } else if (current ?? staged) {
            finalByKey.set(key, current ?? staged!);
          }
        }

        const orderedEntries: SessionCatalogEntry[] = [];
        const seen = new Set<string>();
        for (const entry of [...replacement.entries, ...currentByKey.values()]) {
          const key = sessionKey(entry.sessionRef);
          const finalEntry = finalByKey.get(key);
          if (finalEntry && !seen.has(key)) {
            orderedEntries.push(finalEntry);
            seen.add(key);
          }
        }
        nextEntriesByWorkspace.set(replacement.workspaceId, orderedEntries);
        for (const entry of [...replacement.baselineEntries, ...currentByKey.values()]) {
          const key = sessionKey(entry.sessionRef);
          if (!finalByKey.has(key)) removed.set(key, entry.sessionRef);
        }
      }

      const nextSessions: SessionCatalogEntry[] = [];
      const insertedWorkspaces = new Set<WorkspaceId>();
      for (const entry of state.sessions) {
        const replacementEntries = nextEntriesByWorkspace.get(entry.workspaceId);
        if (!replacementEntries) {
          nextSessions.push(entry);
        } else if (!insertedWorkspaces.has(entry.workspaceId)) {
          nextSessions.push(...replacementEntries);
          insertedWorkspaces.add(entry.workspaceId);
        }
      }
      for (const [workspaceId, entries] of nextEntriesByWorkspace) {
        if (!insertedWorkspaces.has(workspaceId)) nextSessions.push(...entries);
      }

      const nextSessionFiles = { ...state.sessionFiles };
      for (const replacement of replacements) {
        const prefix = `${replacement.workspaceId}:`;
        for (const key of Object.keys(nextSessionFiles)) {
          if (key.startsWith(prefix)) delete nextSessionFiles[key];
        }
        const baselineByKey = new Map(
          replacement.baselineEntries.map((entry) => [sessionKey(entry.sessionRef), entry]),
        );
        const currentByKey = new Map(
          state.sessions
            .filter((entry) => entry.workspaceId === replacement.workspaceId)
            .map((entry) => [sessionKey(entry.sessionRef), entry]),
        );
        for (const entry of nextEntriesByWorkspace.get(replacement.workspaceId) ?? []) {
          const key = sessionKey(entry.sessionRef);
          const baseline = baselineByKey.get(key);
          const current = currentByKey.get(key);
          const baselinePath =
            replacement.baselineSessionFiles[key] || baseline?.sessionFilePath;
          const currentPath = state.sessionFiles[key] || current?.sessionFilePath;
          const changedSinceScan =
            current &&
            (!baseline ||
              !areSessionEntriesEqual(current, baseline) ||
              currentPath !== baselinePath);
          const filePath = changedSinceScan
            ? currentPath
            : replacement.sessionFiles[key] ?? state.sessionFiles[key] ?? entry.sessionFilePath;
          if (filePath) nextSessionFiles[key] = filePath;
        }
      }

      const workspacesChanged = !areWorkspaceListsEqual(state.workspaces, nextWorkspaces);
      const sessionsChanged = !areSessionListsEqual(state.sessions, nextSessions);
      const sessionFilesChanged = !areStringRecordsEqual(state.sessionFiles, nextSessionFiles);
      removedSessionRefs = [...removed.values()];
      if (!workspacesChanged && !sessionsChanged && !sessionFilesChanged) return false;
      state.workspaces = nextWorkspaces;
      state.sessions = nextSessions;
      state.sessionFiles = nextSessionFiles;
    });
    return removedSessionRefs;
  }

  private async getState(): Promise<CatalogFileState> {
    const generation = this.coordinator.generation;
    if (this.state && this.stateGeneration === generation) {
      return this.state;
    }
    if (!this.loadPromise || this.loadGeneration !== generation) {
      this.loadPromise = this.loadState();
      this.loadGeneration = generation;
    }
    const loadPromise = this.loadPromise;
    try {
      const state = await loadPromise;
      if (this.loadPromise === loadPromise && this.coordinator.generation === generation) {
        this.cacheState(state, generation);
      }
      return state;
    } catch (error) {
      if (this.loadPromise === loadPromise) {
        this.clearStateCache();
      }
      throw error;
    }
  }

  private async loadState(): Promise<CatalogFileState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return parseState(raw, this.filePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return createEmptyState();
      }
      throw error;
    }
  }

  private async mutateState(mutator: (state: CatalogFileState) => void | false): Promise<void> {
    const operation = this.coordinator.mutationQueue.then(async () => {
      this.clearStateCache();
      const nextState = await this.loadState();
      if (mutator(nextState) === false) {
        this.cacheState(nextState, this.coordinator.generation);
        return;
      }
      await writeJsonFileAtomic(this.filePath, nextState);
      this.coordinator.generation += 1;
      this.cacheState(nextState, this.coordinator.generation);
    });

    this.coordinator.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );

    await operation;
  }

  private cacheState(state: CatalogFileState, generation: number): void {
    this.state = state;
    this.stateGeneration = generation;
    this.loadPromise = undefined;
    this.loadGeneration = -1;
  }

  private clearStateCache(): void {
    this.state = undefined;
    this.stateGeneration = -1;
    this.loadPromise = undefined;
    this.loadGeneration = -1;
  }
}

function coordinatorForPath(filePath: string): CatalogFileCoordinator {
  const existing = coordinatorsByPath.get(filePath);
  if (existing) {
    return existing;
  }
  const coordinator: CatalogFileCoordinator = {
    mutationQueue: Promise.resolve(),
    generation: 0,
  };
  coordinatorsByPath.set(filePath, coordinator);
  return coordinator;
}

function defaultCatalogFilePath(): string {
  return join(homedir(), ".pi-gui", "catalogs.json");
}

function compareWorkspaceEntries(
  left: WorkspaceCatalogEntry,
  right: WorkspaceCatalogEntry,
): number {
  if (left.pinned && !right.pinned) return -1;
  if (!left.pinned && right.pinned) return 1;
  if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
  return right.lastOpenedAt.localeCompare(left.lastOpenedAt);
}

function compareSessionEntries(left: SessionCatalogEntry, right: SessionCatalogEntry): number {
  const archiveRank = rankSessionArchiveState(left) - rankSessionArchiveState(right);
  if (archiveRank !== 0) return archiveRank;
  const statusRank = rankSessionStatus(left.status) - rankSessionStatus(right.status);
  if (statusRank !== 0) return statusRank;
  return right.updatedAt.localeCompare(left.updatedAt);
}

function compareWorktreeEntries(left: WorktreeCatalogEntry, right: WorktreeCatalogEntry): number {
  if (left.kind !== right.kind) {
    return left.kind === "primary" ? -1 : 1;
  }
  if (left.pinned && !right.pinned) return -1;
  if (!left.pinned && right.pinned) return 1;
  if (left.updatedAt !== right.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
  return left.displayName.localeCompare(right.displayName);
}

function areWorktreeListsEqual(
  left: readonly WorktreeCatalogEntry[],
  right: readonly WorktreeCatalogEntry[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const sortedRight = [...right].sort(compareWorktreeEntries);
  return left.every((entry, index) => areWorktreeEntriesEqual(entry, sortedRight[index]));
}

function areWorkspaceListsEqual(
  left: readonly WorkspaceCatalogEntry[],
  right: readonly WorkspaceCatalogEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => areWorkspaceEntriesEqual(entry, right[index]))
  );
}

function areWorkspaceEntriesEqual(
  left: WorkspaceCatalogEntry,
  right: WorkspaceCatalogEntry | undefined,
): boolean {
  return Boolean(
    right &&
      left.workspaceId === right.workspaceId &&
      left.path === right.path &&
      left.displayName === right.displayName &&
      left.lastOpenedAt === right.lastOpenedAt &&
      left.sortOrder === right.sortOrder &&
      left.pinned === right.pinned,
  );
}

function areSessionListsEqual(
  left: readonly SessionCatalogEntry[],
  right: readonly SessionCatalogEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => areSessionEntriesEqual(entry, right[index]!))
  );
}

function areStringRecordsEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

function areSessionEntriesEqual(left: SessionCatalogEntry, right: SessionCatalogEntry): boolean {
  return (
    left.sessionRef.workspaceId === right.sessionRef.workspaceId &&
    left.sessionRef.sessionId === right.sessionRef.sessionId &&
    left.workspaceId === right.workspaceId &&
    left.title === right.title &&
    left.updatedAt === right.updatedAt &&
    left.archivedAt === right.archivedAt &&
    left.previewSnippet === right.previewSnippet &&
    left.sessionFilePath === right.sessionFilePath &&
    left.status === right.status
  );
}

function areWorktreeEntriesEqual(
  left: WorktreeCatalogEntry,
  right: WorktreeCatalogEntry | undefined,
): boolean {
  if (!right) {
    return false;
  }

  return (
    left.worktreeId === right.worktreeId &&
    left.workspaceId === right.workspaceId &&
    left.path === right.path &&
    left.displayName === right.displayName &&
    left.kind === right.kind &&
    left.status === right.status &&
    left.branchName === right.branchName &&
    left.headSha === right.headSha &&
    left.pinned === right.pinned &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

function rankSessionStatus(status: SessionCatalogEntry["status"]): number {
  if (status === "running") return 0;
  if (status === "idle") return 1;
  return 2;
}

function rankSessionArchiveState(session: SessionCatalogEntry): number {
  return session.archivedAt ? 1 : 0;
}
