import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { SessionDriverEvent, SessionRef, SessionSnapshot } from "@pi-gui/session-driver";
import type { DesktopAppState } from "../../contracts/desktop-state";

const STATE_VERSION = 1;
const MAX_ACTIVE_RUNS = 2;
const MAX_QUEUED_RUNS = 12;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_RETAINED_RUNS = 500;
const MAX_STATE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_LIST_LIMIT = 20;
const MAX_WORKSPACE_SESSION_SUMMARIES = 500;
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;
const MAX_RUN_TIMEOUT_MS = 10 * 60_000;
const STATE_FILE_NAME = "native-automation.json";

export interface AutomationRoute {
  /** Absolute workspace root. The request body can never supply or override this path. */
  readonly workspacePath: string;
  readonly title?: string;
  /** Owner-granted per-route opt-in for Discord thread children. */
  readonly allowThreads?: boolean;
}

export interface NativeAutomationStore {
  getState(): Promise<Pick<DesktopAppState, "workspaces">>;
  /** Creates a visible, native Pi thread and returns its immutable reference. */
  createSession(input: {
    readonly workspaceId: string;
    readonly title?: string;
  }): Promise<SessionRef>;
  ensureSessionReady(
    sessionRef: SessionRef,
  ): Promise<Pick<SessionSnapshot, "status" | "runningRunId"> | undefined>;
  /** Must submit into the referenced native Pi session, never create a second runtime. */
  submitComposer(sessionRef: SessionRef, text: string): Promise<unknown>;
  cancelCurrentRun(sessionRef: SessionRef): Promise<unknown>;
  subscribeToSessionEvents(listener: (event: SessionDriverEvent) => void): () => void;
}

export interface NativeAutomationConfig {
  /** Reloaded for each request so owner-granted route access takes effect immediately. */
  loadRoutes(): Promise<Readonly<Record<string, AutomationRoute>>>;
  /** Only these exact route IDs may have `/thread/<digits>` children. */
  readonly threadRoutePrefixes?: readonly string[];
  /** Finite upper bound for each native prompt, defaulting to ten minutes. */
  readonly timeoutMs?: number;
}

export type AutomationRunStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface AutomationRunUpdate {
  readonly runId: string;
  readonly routeId: string;
  readonly status: AutomationRunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt?: string;
  readonly text?: string;
  readonly error?: string;
}

export interface NativeAutomationIngress {
  /** Loopback-only origin, for example `http://127.0.0.1:43127`. */
  readonly origin: string;
  /** Random bearer token. Keep this in the app's private user-data storage. */
  readonly token: string;
  onRunUpdate(listener: (run: AutomationRunUpdate) => void): () => void;
  close(): Promise<void>;
}

interface StoredRun {
  runId: string;
  routeId: string;
  status: AutomationRunStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  text?: string;
  error?: string;
  messageId: string;
  cancelRequested?: boolean;
  timeoutRequested?: boolean;
  nativeRunId?: string;
}

interface StoredState {
  readonly version: typeof STATE_VERSION;
  routes: Record<string, SessionRef>;
  runs: StoredRun[];
}

interface SubmitInput {
  readonly routeId: string;
  readonly messageId: string;
  readonly text: string;
}

interface RouteResolution {
  readonly routeId: string;
  readonly route: AutomationRoute;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
      resolvePromise = undefined;
    },
  };
}

function sessionKey(ref: SessionRef): string {
  return `${ref.workspaceId}\u0000${ref.sessionId}`;
}

function normalizeWorkspacePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionRef(value: unknown): value is SessionRef {
  return (
    isRecord(value) &&
    typeof value.workspaceId === "string" &&
    value.workspaceId.length > 0 &&
    value.workspaceId.length <= 256 &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    value.sessionId.length <= 256
  );
}

function isRunStatus(value: unknown): value is AutomationRunStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "interrupted"
  );
}

function isStoredRun(value: unknown): value is StoredRun {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    value.runId.length <= 64 &&
    typeof value.routeId === "string" &&
    value.routeId.length <= 512 &&
    typeof value.messageId === "string" &&
    value.messageId.length <= 256 &&
    isRunStatus(value.status) &&
    typeof value.createdAt === "string" &&
    value.createdAt.length <= 64 &&
    typeof value.updatedAt === "string" &&
    value.updatedAt.length <= 64 &&
    (value.finishedAt === undefined ||
      (typeof value.finishedAt === "string" && value.finishedAt.length <= 64)) &&
    (value.text === undefined ||
      (typeof value.text === "string" &&
        Buffer.byteLength(value.text, "utf8") <= MAX_OUTPUT_BYTES)) &&
    (value.error === undefined || (typeof value.error === "string" && value.error.length <= 512)) &&
    (value.cancelRequested === undefined || typeof value.cancelRequested === "boolean") &&
    (value.timeoutRequested === undefined || typeof value.timeoutRequested === "boolean") &&
    (value.nativeRunId === undefined ||
      (typeof value.nativeRunId === "string" && value.nativeRunId.length <= 256))
  );
}

function publicRun(run: StoredRun): AutomationRunUpdate {
  return {
    runId: run.runId,
    routeId: run.routeId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.text ? { text: run.text } : {}),
    ...(run.error ? { error: run.error } : {}),
  };
}

function safeError(_error: unknown): string {
  // Provider and filesystem error text can contain account, endpoint, and local path details.
  return "The native Pi run could not be completed.";
}

function isTerminal(status: AutomationRunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

async function readState(statePath: string): Promise<StoredState> {
  let info;
  try {
    info = await lstat(statePath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { version: STATE_VERSION, routes: {}, runs: [] };
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Native automation state is not a regular file.");
  }
  if (info.size > MAX_STATE_FILE_BYTES) throw new Error("Native automation state is too large.");

  const parsed: unknown = JSON.parse(await readFile(statePath, "utf8"));
  if (!isRecord(parsed) || parsed.version !== STATE_VERSION || !isRecord(parsed.routes)) {
    throw new Error("Native automation state has an unsupported format.");
  }
  const routes: Record<string, SessionRef> = {};
  for (const [routeId, ref] of Object.entries(parsed.routes)) {
    if (!routeId || !isSessionRef(ref))
      throw new Error("Native automation route state is invalid.");
    routes[routeId] = { workspaceId: ref.workspaceId, sessionId: ref.sessionId };
  }
  if (!Array.isArray(parsed.runs) || !parsed.runs.every(isStoredRun)) {
    throw new Error("Native automation run state is invalid.");
  }
  return {
    version: STATE_VERSION,
    routes,
    runs: parsed.runs.map((run) => ({ ...run })),
  };
}

function jsonResponse(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function unauthorized(response: ServerResponse): void {
  jsonResponse(response, 401, { error: "Unauthorized" });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    throw new HttpError(415, "Expected application/json.");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer =
      typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large.");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function parseSubmitInput(value: unknown): SubmitInput {
  if (!isRecord(value)) throw new HttpError(400, "Expected a JSON object.");
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "routeId" && key !== "messageId" && key !== "text")) {
    throw new HttpError(400, "Unknown request field.");
  }
  const { routeId, messageId, text } = value;
  if (
    typeof routeId !== "string" ||
    routeId.length < 1 ||
    routeId.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(routeId)
  ) {
    throw new HttpError(400, "Invalid routeId.");
  }
  if (
    typeof messageId !== "string" ||
    messageId.length < 1 ||
    messageId.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(messageId)
  ) {
    throw new HttpError(400, "Invalid messageId.");
  }
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES ||
    !text.trim()
  ) {
    throw new HttpError(400, "Invalid text.");
  }
  if (text.trimStart().startsWith("/")) {
    throw new HttpError(400, "Slash commands are not accepted by the automation ingress.");
  }
  return { routeId, messageId, text };
}

function authorizationMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function startAutomationIngress(options: {
  readonly store: NativeAutomationStore;
  readonly userDataDir: string;
  readonly config: NativeAutomationConfig;
}): Promise<NativeAutomationIngress> {
  if (!isAbsolute(options.userDataDir)) throw new Error("userDataDir must be absolute.");
  const runTimeoutMs = options.config.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  if (!Number.isFinite(runTimeoutMs) || runTimeoutMs <= 0 || runTimeoutMs > MAX_RUN_TIMEOUT_MS) {
    throw new Error("Automation timeoutMs must be finite and at most ten minutes.");
  }
  await mkdir(options.userDataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(options.userDataDir, 0o700);

  const statePath = join(options.userDataDir, STATE_FILE_NAME);
  const state = await readState(statePath);
  let wasRecovered = false;
  for (const run of state.runs) {
    if (run.status === "queued" || run.status === "running") {
      run.status = "interrupted";
      run.updatedAt = new Date().toISOString();
      run.finishedAt = run.updatedAt;
      run.error = "The desktop process restarted before this run completed.";
      wasRecovered = true;
    }
  }

  const token = randomBytes(32).toString("base64url");
  const listeners = new Set<(run: AutomationRunUpdate) => void>();
  const activeByRoute = new Map<string, StoredRun>();
  const activeBySession = new Map<string, StoredRun>();
  const activeRoutes = new Set<string>();
  const terminalWaiters = new Map<string, Deferred<AutomationRunStatus>>();
  const sessionRefs = state.routes;
  let activeCount = 0;
  let closed = false;
  let pumpQueued = false;
  let persistTail: Promise<void> = Promise.resolve();
  let enqueueTail: Promise<void> = Promise.resolve();
  const promptByRun = new Map<string, string>();

  const persistNow = async (): Promise<void> => {
    const snapshot: StoredState = {
      version: STATE_VERSION,
      routes: { ...sessionRefs },
      runs: state.runs.slice(-MAX_RETAINED_RUNS).map((run) => ({ ...run })),
    };
    const tempPath = `${statePath}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(snapshot)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") await chmod(tempPath, 0o600);
    await rename(tempPath, statePath);
  };
  const persist = (): Promise<void> => {
    persistTail = persistTail.catch(() => undefined).then(persistNow);
    return persistTail;
  };
  const emit = (run: StoredRun): void => {
    const update = publicRun(run);
    for (const listener of listeners) {
      try {
        listener(update);
      } catch {
        // A transport listener cannot wedge a native Pi run.
      }
    }
  };
  const touch = (run: StoredRun): void => {
    run.updatedAt = new Date().toISOString();
    emit(run);
  };
  const finish = (
    run: StoredRun,
    status: Extract<AutomationRunStatus, "completed" | "failed" | "cancelled">,
    error?: string,
  ): void => {
    if (isTerminal(run.status)) return;
    run.status = run.timeoutRequested ? "failed" : run.cancelRequested ? "cancelled" : status;
    run.updatedAt = new Date().toISOString();
    run.finishedAt = run.updatedAt;
    if (run.timeoutRequested) run.error = "The native Pi run exceeded its time limit.";
    else if (error) run.error = error;
    emit(run);
    terminalWaiters.get(run.runId)?.resolve(run.status);
    void persist().catch(() => undefined);
  };

  const unsubscribe = options.store.subscribeToSessionEvents((event) => {
    if (closed) return;
    const run = activeBySession.get(sessionKey(event.sessionRef));
    if (!run || run.status !== "running") return;
    if (event.runId) {
      if (run.nativeRunId && run.nativeRunId !== event.runId) return;
      run.nativeRunId ??= event.runId;
    }
    if (event.type === "sessionUpdated" && event.snapshot.status === "running") {
      run.nativeRunId ??= event.snapshot.runningRunId;
    } else if (event.type === "assistantDelta") {
      const safeDelta = event.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
      let remainingBytes = MAX_OUTPUT_BYTES - Buffer.byteLength(run.text ?? "", "utf8");
      if (remainingBytes > 0) {
        let delta = "";
        for (const character of safeDelta) {
          const characterBytes = Buffer.byteLength(character, "utf8");
          if (characterBytes > remainingBytes) break;
          delta += character;
          remainingBytes -= characterBytes;
        }
        run.text = `${run.text ?? ""}${delta}`;
        touch(run);
      }
    } else if (event.type === "runCompleted") {
      finish(run, "completed");
    } else if (event.type === "runFailed") {
      finish(run, "failed", safeError(event.error));
    }
  });

  const resolveRoute = async (routeId: string): Promise<RouteResolution> => {
    const routes = await options.config.loadRoutes();
    const direct = Object.hasOwn(routes, routeId) ? routes[routeId] : undefined;
    if (direct) return { routeId, route: direct };
    const thread = routeId.match(/^(.*)\/thread\/(\d+)$/u);
    if (!thread) throw new HttpError(403, "Route is not allowed.");
    const baseRouteId = thread[1]!;
    const prefixes = options.config.threadRoutePrefixes ?? [];
    const baseRoute = Object.hasOwn(routes, baseRouteId) ? routes[baseRouteId] : undefined;
    if (
      !baseRoute ||
      baseRoute.allowThreads !== true ||
      (prefixes.length > 0 && !prefixes.includes(baseRouteId))
    ) {
      throw new HttpError(403, "Route is not allowed.");
    }
    return { routeId, route: baseRoute };
  };

  const resolveWorkspaceId = async (route: AutomationRoute): Promise<string> => {
    if (!isAbsolute(route.workspacePath))
      throw new Error("Configured workspace path must be absolute.");
    const stateSnapshot = await options.store.getState();
    const targetPath = normalizeWorkspacePath(route.workspacePath);
    const matches = stateSnapshot.workspaces.filter((workspace) => {
      return normalizeWorkspacePath(workspace.path) === targetPath;
    });
    if (matches.length !== 1) throw new Error("Configured workspace is unavailable or ambiguous.");
    return matches[0]!.id;
  };

  const getSessionForRoute = async (
    routeId: string,
    route: AutomationRoute,
  ): Promise<SessionRef> => {
    const existing = sessionRefs[routeId];
    const workspaceId = await resolveWorkspaceId(route);
    if (existing) {
      if (existing.workspaceId !== workspaceId)
        throw new Error("Stored route session belongs to a different workspace.");
      const snapshot = await options.store.getState();
      const workspace = snapshot.workspaces.find((entry) => entry.id === workspaceId);
      if (!workspace?.sessions.some((session) => session.id === existing.sessionId)) {
        throw new Error("Stored route session is no longer available.");
      }
      return existing;
    }

    const sessionRef = await options.store.createSession({
      workspaceId,
      ...(route.title ? { title: route.title } : {}),
    });
    if (sessionRef.workspaceId !== workspaceId || !sessionRef.sessionId) {
      throw new Error("Native thread creation returned an invalid session reference.");
    }
    sessionRefs[routeId] = { workspaceId: sessionRef.workspaceId, sessionId: sessionRef.sessionId };
    await persist();
    return sessionRefs[routeId]!;
  };

  const routeIsStillAllowed = async (routeId: string): Promise<void> => {
    await resolveRoute(routeId);
  };

  const findRun = (runId: string): StoredRun | undefined =>
    state.runs.find((run) => run.runId === runId);

  const submitPrompt = async (sessionRef: SessionRef, run: StoredRun): Promise<void> => {
    const prompt = promptByRun.get(run.runId);
    if (prompt === undefined) throw new Error("The queued prompt is unavailable after restart.");
    await options.store.submitComposer(sessionRef, prompt);
    promptByRun.delete(run.runId);
  };

  const runIsAuthorized = async (run: StoredRun): Promise<void> => {
    await routeIsStillAllowed(run.routeId);
  };

  const execute = async (run: StoredRun, route: AutomationRoute): Promise<void> => {
    let sessionRef: SessionRef | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const waiter = deferred<AutomationRunStatus>();
    terminalWaiters.set(run.runId, waiter);
    const timeoutSignal = deferred<void>();
    const cancelAfterTimeout = async (): Promise<void> => {
      if (isTerminal(run.status) || !sessionRef) return;
      run.timeoutRequested = true;
      run.cancelRequested = true;
      touch(run);
      await persist().catch(() => undefined);
      const cancellation = options.store.cancelCurrentRun(sessionRef).catch(() => undefined);
      // Cancellation returning is not proof that pi has stopped. Keep this route slot held until
      // the native terminal event acknowledges the stop.
      await Promise.race([cancellation, waiter.promise]);
      await waiter.promise;
    };
    try {
      sessionRef = await getSessionForRoute(run.routeId, route);
      if (closed) return;
      const snapshot = await options.store.ensureSessionReady(sessionRef);
      if (snapshot?.status === "running") {
        finish(run, "failed", "The native Pi thread is already running; no prompt was sent.");
        return;
      }
      if (run.cancelRequested) {
        finish(run, "cancelled");
        return;
      }

      run.status = "running";
      run.error = undefined;
      touch(run);
      await persist();
      if (closed) return;
      activeByRoute.set(run.routeId, run);
      activeBySession.set(sessionKey(sessionRef), run);
      timeoutTimer = setTimeout(() => timeoutSignal.resolve(), runTimeoutMs);
      timeoutTimer.unref?.();
      const submission = submitPrompt(sessionRef, run).then(
        () => ({ kind: "submitted" as const }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
      const firstOutcome = await Promise.race([
        submission,
        timeoutSignal.promise.then(() => ({ kind: "timeout" as const })),
      ]);
      if (firstOutcome.kind === "timeout") {
        await cancelAfterTimeout();
        return;
      }
      if (firstOutcome.kind === "failed") throw firstOutcome.error;
      if (closed) return;

      if (!isTerminal(run.status)) {
        const after = await options.store.ensureSessionReady(sessionRef);
        if (after?.status !== "running") {
          finish(run, run.cancelRequested ? "cancelled" : "completed");
        } else {
          const terminal = waiter.promise.then(() => ({ kind: "terminal" as const }));
          const outcome = await Promise.race([
            terminal,
            timeoutSignal.promise.then(() => ({ kind: "timeout" as const })),
          ]);
          if (outcome.kind === "timeout") await cancelAfterTimeout();
        }
      }
    } catch (error) {
      if (!closed && !isTerminal(run.status)) finish(run, "failed", safeError(error));
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      terminalWaiters.delete(run.runId);
      if (sessionRef) {
        const key = sessionKey(sessionRef);
        if (activeBySession.get(key) === run) activeBySession.delete(key);
      }
      if (activeByRoute.get(run.routeId) === run) activeByRoute.delete(run.routeId);
      promptByRun.delete(run.runId);
      if (!closed && !isTerminal(run.status))
        finish(run, "failed", "The native Pi run ended without a terminal event.");
    }
  };

  const schedulePump = (): void => {
    if (pumpQueued || closed) return;
    pumpQueued = true;
    queueMicrotask(() => {
      pumpQueued = false;
      while (!closed && activeCount < MAX_ACTIVE_RUNS) {
        const next = state.runs.find(
          (run) => run.status === "queued" && !activeRoutes.has(run.routeId),
        );
        if (!next) return;
        activeRoutes.add(next.routeId);
        activeCount += 1;
        void Promise.resolve()
          .then(async () => {
            const routeResolution = await resolveRoute(next.routeId);
            return execute(next, routeResolution.route);
          })
          .catch((error: unknown) => {
            if (!closed && !isTerminal(next.status)) {
              finish(
                next,
                "failed",
                error instanceof HttpError
                  ? "The configured route is no longer allowed."
                  : safeError(error),
              );
            }
          })
          .finally(() => {
            activeRoutes.delete(next.routeId);
            activeCount -= 1;
            schedulePump();
          });
      }
    });
  };

  const enqueue = (
    input: SubmitInput,
  ): Promise<{ run: AutomationRunUpdate; deduplicated: boolean }> => {
    const result = enqueueTail.then(async () => {
      const resolved = await resolveRoute(input.routeId);
      const existing = state.runs.find(
        (run) => run.routeId === resolved.routeId && run.messageId === input.messageId,
      );
      if (existing) return { run: publicRun(existing), deduplicated: true };

      const queuedCount = state.runs.filter((run) => run.status === "queued").length;
      if (queuedCount >= MAX_QUEUED_RUNS) {
        throw new HttpError(429, "Automation queue is full.");
      }
      const now = new Date().toISOString();
      const run: StoredRun = {
        runId: randomUUID(),
        routeId: resolved.routeId,
        messageId: input.messageId,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      };
      // The prompt is held only in memory and is deliberately not written to the durable ledger.
      promptByRun.set(run.runId, input.text);
      state.runs.push(run);
      trimRuns();
      try {
        await persist();
      } catch (error) {
        state.runs = state.runs.filter((entry) => entry !== run);
        promptByRun.delete(run.runId);
        throw error;
      }
      emit(run);
      schedulePump();
      return { run: publicRun(run), deduplicated: false };
    });
    enqueueTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  function trimRuns(): void {
    if (state.runs.length <= MAX_RETAINED_RUNS) return;
    const removable = state.runs
      .filter((run) => isTerminal(run.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    while (state.runs.length > MAX_RETAINED_RUNS && removable.length > 0) {
      const oldest = removable.shift()!;
      state.runs = state.runs.filter((run) => run !== oldest);
    }
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        if (error instanceof HttpError)
          jsonResponse(response, error.status, { error: error.message });
        else jsonResponse(response, 500, { error: "Automation ingress failed." });
      } else response.destroy();
    });
  });

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (closed) return jsonResponse(response, 503, { error: "Automation ingress is closed." });
    if (!authorizationMatches(request.headers.authorization, token)) return unauthorized(response);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "POST" && url.pathname === "/v1/runs") {
      const input = parseSubmitInput(await readJsonBody(request));
      const result = await enqueue(input);
      return jsonResponse(response, result.deduplicated ? 200 : 202, {
        ...result.run,
        deduplicated: result.deduplicated,
      });
    }

    if (request.method === "GET" && url.pathname === "/v1/runs") {
      const routeId = url.searchParams.get("routeId");
      if (!routeId) throw new HttpError(400, "routeId is required.");
      const allowedRoute = await resolveRoute(routeId);
      const requestedLimit = Number(url.searchParams.get("limit") ?? "20");
      const limit = Number.isInteger(requestedLimit)
        ? Math.max(1, Math.min(MAX_LIST_LIMIT, requestedLimit))
        : 20;
      const runs = state.runs
        .filter((run) => run.routeId === routeId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit)
        .map(publicRun);
      const workspaceState = await options.store.getState();
      const workspacePath = normalizeWorkspacePath(allowedRoute.route.workspacePath);
      const matchingWorkspaces = workspaceState.workspaces.filter(
        (workspace) => normalizeWorkspacePath(workspace.path) === workspacePath,
      );
      const workspace = matchingWorkspaces.length === 1 ? matchingWorkspaces[0] : undefined;
      const nativeSessionCount = workspace?.sessions.length ?? 0;
      const nativeSessions = (workspace?.sessions ?? [])
        .slice(0, MAX_WORKSPACE_SESSION_SUMMARIES)
        .map((session) => ({ id: session.id, status: session.status }));
      const boundSession = sessionRefs[routeId];
      let nativeSession:
        | { readonly id: string; readonly status: string; readonly runningRunId?: string }
        | undefined;
      if (boundSession) {
        try {
          const snapshot = await options.store.ensureSessionReady(boundSession);
          if (snapshot) {
            nativeSession = {
              id: boundSession.sessionId,
              status: snapshot.status,
              ...(snapshot.runningRunId ? { runningRunId: snapshot.runningRunId } : {}),
            };
          }
        } catch {
          nativeSession = { id: boundSession.sessionId, status: "unavailable" };
        }
        if (!nativeSession && workspace) {
          const session = workspace.sessions.find(
            (candidate) => candidate.id === boundSession.sessionId,
          );
          nativeSession = session
            ? { id: session.id, status: session.status }
            : { id: boundSession.sessionId, status: "unavailable" };
        }
      }
      return jsonResponse(response, 200, {
        runs,
        nativeSessions,
        nativeSessionCount,
        nativeSessionsTruncated: nativeSessionCount > nativeSessions.length,
        ...(nativeSession ? { nativeSession } : {}),
      });
    }

    const runPath = url.pathname.match(/^\/v1\/runs\/([0-9a-f-]{36})(?:\/(cancel))?$/iu);
    if (runPath) {
      const run = findRun(runPath[1]!);
      if (!run) return jsonResponse(response, 404, { error: "Run not found." });
      await runIsAuthorized(run);
      if (request.method === "GET" && !runPath[2]) {
        return jsonResponse(response, 200, publicRun(run));
      }
      if (request.method === "POST" && runPath[2] === "cancel") {
        if (run.status === "queued") {
          run.status = "cancelled";
          run.updatedAt = new Date().toISOString();
          run.finishedAt = run.updatedAt;
          run.text = undefined;
          promptByRun.delete(run.runId);
          emit(run);
          await persist();
          return jsonResponse(response, 200, { cancelled: true, run: publicRun(run) });
        }
        if (run.status === "running") {
          run.cancelRequested = true;
          touch(run);
          await persist();
          const sessionRef = sessionRefs[run.routeId];
          if (!sessionRef)
            return jsonResponse(response, 409, { error: "Native session binding is unavailable." });
          await options.store.cancelCurrentRun(sessionRef);
          return jsonResponse(response, 200, { cancelled: true, run: publicRun(run) });
        }
        return jsonResponse(response, 200, { cancelled: false, run: publicRun(run) });
      }
    }

    jsonResponse(response, 404, { error: "Not found." });
  };

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;

  if (wasRecovered) {
    try {
      await persist();
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }
  const addressPromise = new Promise<{ origin: string }>((resolveAddressPromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("Could not bind loopback ingress."));
      resolveAddressPromise({ origin: `http://127.0.0.1:${address.port}` });
    });
  });
  let origin: string;
  try {
    origin = (await addressPromise).origin;
  } catch (error) {
    closed = true;
    unsubscribe();
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    throw error;
  }

  return {
    origin,
    token,
    onRunUpdate(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      listeners.clear();
      await persistTail;
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      }
    },
  };
}
