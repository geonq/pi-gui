import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { SessionDriverEvent, SessionRef, SessionStatus } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import type {
  DesktopAppState,
  DesktopAppViewState,
  SelectedTranscriptRecord,
  WorkspaceKind,
} from "../../contracts/desktop-state";

const API_VERSION = 1 as const;
const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const MAX_SSE_TOTAL = 32;
const MAX_SSE_PER_CLIENT = 4;
const MAX_SSE_BUFFER = 64 * 1024;

export interface RemoteSessionV1 {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly preview: string;
  readonly status: SessionStatus;
  readonly runningSince?: string;
  readonly archivedAt?: string;
  readonly pinnedAt?: string;
  readonly hasUnseenUpdate: boolean;
}
export interface RemoteWorkspaceV1 {
  readonly id: string;
  readonly name: string;
  readonly kind: WorkspaceKind;
  readonly branchName?: string;
  readonly sessions: readonly RemoteSessionV1[];
}
export interface RemoteStoreChangeV1 {
  readonly kind: "catalog" | "session";
  readonly sessionRef?: SessionRef;
}
export interface RemoteAttachmentDownloadV1 {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}
export interface RemoteAttachmentReferenceV1 {
  /** Main-process-only path read from an attachment in the selected native transcript. */
  readonly hostPath: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes?: number;
}
export interface RemoteSessionHostAdapter {
  /** Return safe native summaries; filesystem paths and settings are deliberately absent. */
  getCatalog(): Promise<readonly RemoteWorkspaceV1[]>;
  getTranscript(sessionRef: SessionRef): Promise<readonly TranscriptMessage[] | null>;
  /** Uses the safe native background-instruction path: idle sends a user turn; running queues a follow-up. */
  submitPrompt(input: {
    readonly clientId: string;
    readonly sessionRef: SessionRef;
    readonly text: string;
  }): Promise<void>;
  cancelRun(input: { readonly clientId: string; readonly sessionRef: SessionRef }): Promise<void>;
  /** The opaque ID is resolved by the host to a file attachment found in this exact transcript. */
  readAttachment?(
    sessionRef: SessionRef,
    attachment: RemoteAttachmentReferenceV1,
  ): Promise<RemoteAttachmentDownloadV1 | null>;
  /** Emit change hints only; raw driver events can contain paths and arbitrary tool output. */
  subscribe(listener: (change: RemoteStoreChangeV1) => void): () => void;
}
export interface RemoteSessionHostStorePort {
  getState(): Promise<DesktopAppState>;
  getSelectedTranscriptForView(
    view: Pick<DesktopAppViewState, "selectedWorkspaceId" | "selectedSessionId">,
  ): Promise<SelectedTranscriptRecord | null>;
  subscribe(listener: (state: DesktopAppState) => void): () => void;
  subscribeToSessionEvents(listener: (event: SessionDriverEvent) => void): () => void;
  cancelCurrentRun(sessionRef: SessionRef): Promise<unknown>;
}
export type RemoteSessionPromptSubmitter = (input: {
  readonly clientId: string;
  readonly sessionRef: SessionRef;
  readonly text: string;
}) => Promise<unknown>;

/** Bridges only public AppStore views/actions; prompt delivery remains an explicit safe callback. */
export function createRemoteSessionHostAdapter(
  store: RemoteSessionHostStorePort,
  submitPrompt: RemoteSessionPromptSubmitter,
  readAttachment?: (
    sessionRef: SessionRef,
    attachment: RemoteAttachmentReferenceV1,
  ) => Promise<RemoteAttachmentDownloadV1 | null>,
): RemoteSessionHostAdapter {
  return {
    async getCatalog() {
      const state = await store.getState();
      return state.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        kind: workspace.kind,
        ...(workspace.branchName ? { branchName: workspace.branchName } : {}),
        sessions: workspace.sessions.map((session) => ({
          id: session.id,
          title: session.title,
          updatedAt: session.updatedAt,
          preview: session.preview,
          status: session.status,
          ...(session.runningSince ? { runningSince: session.runningSince } : {}),
          ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}),
          ...(session.pinnedAt ? { pinnedAt: session.pinnedAt } : {}),
          hasUnseenUpdate: session.hasUnseenUpdate,
        })),
      }));
    },
    async getTranscript(sessionRef) {
      const record = await store.getSelectedTranscriptForView({
        selectedWorkspaceId: sessionRef.workspaceId,
        selectedSessionId: sessionRef.sessionId,
      });
      // AppStore resolves invalid views to a global fallback; never return a different session.
      return record?.workspaceId === sessionRef.workspaceId &&
        record.sessionId === sessionRef.sessionId
        ? record.transcript
        : null;
    },
    async submitPrompt(input) {
      await submitPrompt(input);
    },
    async cancelRun(input) {
      await store.cancelCurrentRun(input.sessionRef);
    },
    ...(readAttachment ? { readAttachment } : {}),
    subscribe(listener) {
      const unsubscribeState = store.subscribe(() => listener({ kind: "catalog" }));
      const unsubscribeEvents = store.subscribeToSessionEvents((event) => {
        listener({ kind: "session", sessionRef: event.sessionRef });
      });
      return () => {
        unsubscribeState();
        unsubscribeEvents();
      };
    },
  };
}

export interface RemoteSessionHostClient {
  /** Stable per-device ID. Give each device a different ID to isolate its selected view. */
  readonly id: string;
  /** At least 32 characters of random device-specific secret. */
  readonly token: string;
  readonly workspaceIds: readonly string[];
  readonly initialWorkspaceId?: string;
  readonly initialSessionId?: string;
}
export interface RemoteSessionHostConfig {
  readonly clients: readonly RemoteSessionHostClient[];
  /** Exact Origin values only. Add "null" only for an opaque Electron origin. */
  readonly allowedOrigins: readonly string[];
  readonly adapter: RemoteSessionHostAdapter;
  /** Defaults to an ephemeral port. The server always binds to loopback IPv4. */
  readonly port?: number;
}
export interface RemoteSessionHost {
  readonly origin: string;
  close(): Promise<void>;
}
export interface RemoteViewV1 {
  readonly workspaceId: string;
  readonly sessionId: string;
}
export interface RemoteSessionHostEventV1 {
  readonly type: "ready" | "viewChanged" | "catalogChanged" | "sessionChanged";
  readonly view?: RemoteViewV1;
  readonly sessionRef?: SessionRef;
  readonly timestamp: string;
}

interface ClientRecord {
  readonly config: RemoteSessionHostClient;
  readonly tokenDigest: Buffer;
}
interface SseConnection {
  readonly clientId: string;
  readonly response: ServerResponse;
  heartbeat: ReturnType<typeof setInterval>;
}
class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0")
  );
}
function validateOrigins(origins: readonly string[]): Set<string> {
  if (origins.length === 0) throw new Error("At least one exact remote API origin is required.");
  const result = new Set<string>();
  for (const origin of origins) {
    if (
      typeof origin !== "string" ||
      origin.length === 0 ||
      origin.length > 256 ||
      origin === "*" ||
      /[\r\n]/u.test(origin)
    ) {
      throw new Error("Remote API origins must be exact origin strings.");
    }
    if (origin !== "null") {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw new Error("Remote API origin is invalid.");
      }
      const webOrigin =
        parsed.origin === origin && (parsed.protocol === "http:" || parsed.protocol === "https:");
      const appOrigin =
        /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+$/iu.test(origin) &&
        (parsed.pathname === "/" || parsed.pathname === "") &&
        parsed.search === "" &&
        parsed.hash === "";
      if (!webOrigin && !appOrigin) {
        throw new Error("Remote API origins cannot include paths, queries, or fragments.");
      }
    }
    result.add(origin);
  }
  return result;
}
function validateClients(configs: readonly RemoteSessionHostClient[]): Map<string, ClientRecord> {
  if (configs.length === 0) throw new Error("At least one remote API client is required.");
  const clients = new Map<string, ClientRecord>();
  const tokenDigests = new Set<string>();
  for (const config of configs) {
    if (!isIdentifier(config.id) || clients.has(config.id))
      throw new Error("Remote client IDs must be unique.");
    if (typeof config.token !== "string" || !/^[A-Za-z0-9._~-]{32,256}$/u.test(config.token)) {
      throw new Error("Remote API tokens must be 32 to 256 URL-safe characters.");
    }
    const tokenDigest = createHash("sha256").update(config.token, "utf8").digest();
    const fingerprint = tokenDigest.toString("hex");
    if (tokenDigests.has(fingerprint)) throw new Error("Remote API client tokens must be unique.");
    tokenDigests.add(fingerprint);
    if (
      !Array.isArray(config.workspaceIds) ||
      config.workspaceIds.some((id) => !isIdentifier(id)) ||
      new Set(config.workspaceIds).size !== config.workspaceIds.length
    ) {
      throw new Error("Remote clients require a unique workspace allowlist.");
    }
    if (config.initialWorkspaceId && !config.workspaceIds.includes(config.initialWorkspaceId)) {
      throw new Error("The initial workspace must be in the client's workspace allowlist.");
    }
    if (config.initialSessionId && !config.initialWorkspaceId) {
      throw new Error("An initial session requires an initial workspace.");
    }
    clients.set(config.id, { config, tokenDigest });
  }
  return clients;
}
function authenticate(
  request: IncomingMessage,
  clients: ReadonlyMap<string, ClientRecord>,
): ClientRecord {
  const header = request.headers.authorization;
  const match =
    typeof header === "string" ? /^Bearer ([A-Za-z0-9._~-]{32,256})$/u.exec(header) : null;
  const token = match?.[1] ?? "";
  const digest = createHash("sha256").update(token, "utf8").digest();
  let result: ClientRecord | undefined;
  for (const client of clients.values()) {
    if (timingSafeEqual(digest, client.tokenDigest)) result = client;
  }
  if (!match || !result)
    throw new HttpError(401, "unauthorized", "A valid bearer token is required.");
  return result;
}
function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, "invalid_request", "The request contains an unsupported field.");
  }
}
function requireEmptyBody(request: IncomingMessage): void {
  const length = request.headers["content-length"];
  if (
    request.headers["transfer-encoding"] !== undefined ||
    (length !== undefined && length !== "0")
  ) {
    request.resume();
    throw new HttpError(400, "unexpected_body", "This endpoint does not accept a request body.");
  }
}
async function readJsonObject(
  request: IncomingMessage,
  limit: number,
): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    request.resume();
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
  const length = request.headers["content-length"];
  if (length !== undefined) {
    if (!/^[0-9]+$/u.test(length)) {
      request.resume();
      throw new HttpError(400, "invalid_content_length", "Content-Length is invalid.");
    }
    if (Number(length) > limit) {
      request.resume();
      throw new HttpError(413, "body_too_large", "The request body exceeds its size limit.");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > limit) {
        settled = true;
        chunks.length = 0;
        reject(new HttpError(413, "body_too_large", "The request body exceeds its size limit."));
        request.resume();
      } else {
        chunks.push(bytes);
      }
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
    if (!isRecord(value)) throw new HttpError(400, "invalid_json", "A JSON object is required.");
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
}
function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  limit = MAX_RESPONSE_BYTES,
): void {
  const text = JSON.stringify(value);
  if (typeof text !== "string")
    throw new HttpError(500, "serialization_failed", "The response could not be serialized.");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > limit)
    throw new HttpError(413, "response_too_large", "The response exceeds its size limit.");
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": String(bytes.byteLength),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(bytes);
}
function writeError(response: ServerResponse, error: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  const known = error instanceof HttpError ? error : undefined;
  try {
    writeJson(
      response,
      known?.status ?? 500,
      {
        version: API_VERSION,
        error: {
          code: known?.code ?? "internal_error",
          message: known?.message ?? "The remote native session request failed.",
        },
      },
      8 * 1024,
    );
  } catch {
    response.destroy();
  }
}
function safeFileName(name: string): string {
  return (
    name
      .replace(/[\u0000-\u001f\u007f"\\/]/gu, "_")
      .replace(/[^A-Za-z0-9._ -]/gu, "_")
      .slice(0, 120)
      .trim() || "attachment"
  );
}
function safeMimeType(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(value)
    ? value
    : "application/octet-stream";
}
interface StoredAttachmentReference {
  readonly sessionKey: string;
  readonly reference: RemoteAttachmentReferenceV1;
}
function sessionKey(ref: SessionRef): string {
  return ref.workspaceId + "\0" + ref.sessionId;
}
function clearAttachmentRefsForSession(
  sessionRef: SessionRef,
  attachmentRefs: Map<string, StoredAttachmentReference>,
): void {
  const key = sessionKey(sessionRef);
  for (const [id, entry] of attachmentRefs) {
    if (entry.sessionKey === key) attachmentRefs.delete(id);
  }
}
function sanitizeTranscript(
  transcript: readonly TranscriptMessage[],
  sessionRef: SessionRef,
  attachmentRefs: Map<string, StoredAttachmentReference>,
): readonly unknown[] {
  const key = sessionKey(sessionRef);
  clearAttachmentRefsForSession(sessionRef, attachmentRefs);
  const sanitize = (value: unknown, isAttachment = false): unknown => {
    if (Array.isArray(value)) return value.map((item) => sanitize(item));
    if (!isRecord(value)) return value;
    if (
      isAttachment &&
      value.kind === "file" &&
      typeof value.fsPath === "string" &&
      value.fsPath.length > 0 &&
      value.fsPath.length <= 32_768
    ) {
      let id: string;
      do {
        id = randomBytes(24).toString("base64url");
      } while (attachmentRefs.has(id));
      const reference: RemoteAttachmentReferenceV1 = {
        hostPath: value.fsPath,
        name: typeof value.name === "string" ? value.name.slice(0, 1_000) : "attachment",
        mimeType:
          typeof value.mimeType === "string"
            ? value.mimeType.slice(0, 256)
            : "application/octet-stream",
        ...(typeof value.sizeBytes === "number" &&
        Number.isFinite(value.sizeBytes) &&
        value.sizeBytes >= 0
          ? { sizeBytes: value.sizeBytes }
          : {}),
      };
      while (attachmentRefs.size >= 10_000) {
        const oldest = attachmentRefs.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        attachmentRefs.delete(oldest);
      }
      attachmentRefs.set(id, { sessionKey: key, reference });
      return {
        kind: "file",
        name: reference.name,
        mimeType: reference.mimeType,
        ...(reference.sizeBytes !== undefined ? { sizeBytes: reference.sizeBytes } : {}),
        attachmentId: id,
      };
    }
    const result: Record<string, unknown> = {};
    for (const [property, item] of Object.entries(value)) {
      if (property === "fsPath") continue;
      result[property] =
        property === "attachments" && Array.isArray(item)
          ? item.map((attachment) => sanitize(attachment, true))
          : sanitize(item);
    }
    return result;
  };

  return transcript.map((item) => sanitize(item));
}

export async function startRemoteSessionHost(
  config: RemoteSessionHostConfig,
): Promise<RemoteSessionHost> {
  const clients = validateClients(config.clients);
  const allowedOrigins = validateOrigins(config.allowedOrigins);
  const port = config.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("The remote API port is invalid.");

  const views = new Map<string, RemoteViewV1>();
  const attachmentRefs = new Map<string, StoredAttachmentReference>();
  const streams = new Set<SseConnection>();
  let eventId = 1;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let server: Server;
  const removeStream = (stream: SseConnection): void => {
    clearInterval(stream.heartbeat);
    streams.delete(stream);
  };
  const sendEvent = (stream: SseConnection, event: RemoteSessionHostEventV1): void => {
    if (stream.response.writableEnded || stream.response.destroyed) {
      removeStream(stream);
      return;
    }
    if (stream.response.writableLength > MAX_SSE_BUFFER) {
      stream.response.end();
      removeStream(stream);
      return;
    }
    const frame =
      "id: " +
      String(eventId++) +
      "\nevent: " +
      event.type +
      "\ndata: " +
      JSON.stringify(event) +
      "\n\n";
    if (!stream.response.write(frame)) {
      stream.response.end();
      removeStream(stream);
    }
  };
  const sendClientEvent = (clientId: string, event: RemoteSessionHostEventV1): void => {
    for (const stream of streams) if (stream.clientId === clientId) sendEvent(stream, event);
  };
  const unsubscribe = config.adapter.subscribe((change) => {
    if (closed) return;
    if (change.kind === "catalog") {
      for (const client of clients.values()) {
        sendClientEvent(client.config.id, {
          type: "catalogChanged",
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }
    const ref = change.sessionRef;
    if (
      change.kind !== "session" ||
      !ref ||
      !isIdentifier(ref.workspaceId) ||
      !isIdentifier(ref.sessionId)
    )
      return;
    for (const client of clients.values()) {
      if (!client.config.workspaceIds.includes(ref.workspaceId)) continue;
      const view = views.get(client.config.id);
      sendClientEvent(
        client.config.id,
        view?.workspaceId === ref.workspaceId && view.sessionId === ref.sessionId
          ? {
              type: "sessionChanged",
              sessionRef: { workspaceId: ref.workspaceId, sessionId: ref.sessionId },
              timestamp: new Date().toISOString(),
            }
          : { type: "catalogChanged", timestamp: new Date().toISOString() },
      );
    }
  });

  const catalogFor = async (client: ClientRecord): Promise<readonly RemoteWorkspaceV1[]> => {
    // The injected main-process adapter returns a typed, explicitly projected catalog.
    const all = await config.adapter.getCatalog();
    const allowlist = new Set(client.config.workspaceIds);
    return all.filter((workspace) => allowlist.has(workspace.id));
  };
  const viewFor = (client: ClientRecord, catalog: readonly RemoteWorkspaceV1[]): RemoteViewV1 => {
    const previous = views.get(client.config.id);
    const workspace =
      catalog.find((row) => row.id === previous?.workspaceId) ??
      catalog.find((row) => row.id === client.config.initialWorkspaceId) ??
      catalog[0];
    if (!workspace) {
      const empty = { workspaceId: "", sessionId: "" };
      views.set(client.config.id, empty);
      return empty;
    }
    const sessionId =
      workspace.sessions.find(
        (row) => row.id === previous?.sessionId && workspace.id === previous?.workspaceId,
      )?.id ??
      workspace.sessions.find(
        (row) =>
          row.id === client.config.initialSessionId &&
          workspace.id === client.config.initialWorkspaceId,
      )?.id ??
      workspace.sessions[0]?.id ??
      "";
    const view = { workspaceId: workspace.id, sessionId };
    views.set(client.config.id, view);
    return view;
  };
  const selectedSession = (catalog: readonly RemoteWorkspaceV1[], view: RemoteViewV1) =>
    catalog
      .find((workspace) => workspace.id === view.workspaceId)
      ?.sessions.find((session) => session.id === view.sessionId);
  const originFor = (actualPort: number) => "http://" + HOST + ":" + String(actualPort);

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : undefined;
    if (actualPort === undefined || request.headers.host !== HOST + ":" + String(actualPort)) {
      writeError(
        response,
        new HttpError(400, "invalid_host", "The Host header must match the loopback API."),
      );
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (typeof origin !== "string" || !allowedOrigins.has(origin)) {
        writeError(
          response,
          new HttpError(403, "origin_denied", "The request origin is not allowed."),
        );
        return;
      }
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      try {
        requireEmptyBody(request);
      } catch (error) {
        writeError(response, error);
        return;
      }
      if (!origin) {
        writeError(
          response,
          new HttpError(403, "origin_required", "A permitted origin is required for preflight."),
        );
        return;
      }
      response.writeHead(204, {
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Last-Event-ID",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Max-Age": "600",
        "Content-Length": "0",
      });
      response.end();
      return;
    }

    let client: ClientRecord;
    try {
      client = authenticate(request, clients);
    } catch (error) {
      request.resume();
      writeError(response, error);
      return;
    }

    let url: URL;
    try {
      url = new URL(request.url ?? "/", originFor(actualPort));
    } catch {
      writeError(response, new HttpError(400, "invalid_url", "The request URL is invalid."));
      return;
    }
    if (url.origin !== originFor(actualPort) || url.search || url.hash) {
      writeError(response, new HttpError(400, "invalid_url", "The request URL is not allowed."));
      return;
    }
    const hasJsonBody =
      request.method === "POST" &&
      (url.pathname === "/v1/view" || url.pathname === "/v1/session/prompt");
    if (!hasJsonBody) {
      try {
        requireEmptyBody(request);
      } catch (error) {
        writeError(response, error);
        return;
      }
    }

    try {
      if (request.method === "GET" && url.pathname === "/v1/catalog") {
        writeJson(response, 200, { version: API_VERSION, workspaces: await catalogFor(client) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/state") {
        const catalog = await catalogFor(client);
        const view = viewFor(client, catalog);
        const workspace = catalog.find((row) => row.id === view.workspaceId);
        writeJson(response, 200, {
          version: API_VERSION,
          view,
          workspace: workspace
            ? { id: workspace.id, name: workspace.name, kind: workspace.kind }
            : null,
          session: selectedSession(catalog, view) ?? null,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/view") {
        const body = await readJsonObject(request, MAX_BODY_BYTES);
        exactKeys(body, ["workspaceId", "sessionId"]);
        if (!isIdentifier(body.workspaceId))
          throw new HttpError(400, "invalid_workspace", "A workspace ID is required.");
        if (
          body.sessionId !== undefined &&
          (typeof body.sessionId !== "string" || body.sessionId.length > 256)
        ) {
          throw new HttpError(400, "invalid_session", "The session ID is invalid.");
        }
        const catalog = await catalogFor(client);
        const workspace = catalog.find((row) => row.id === body.workspaceId);
        if (!workspace)
          throw new HttpError(
            404,
            "workspace_not_found",
            "The workspace is not available to this client.",
          );
        const previous = views.get(client.config.id);
        let sessionId: string;
        if (body.sessionId !== undefined) {
          sessionId = body.sessionId as string;
          if (sessionId && !workspace.sessions.some((row) => row.id === sessionId)) {
            throw new HttpError(404, "session_not_found", "The session is not in that workspace.");
          }
        } else if (
          previous?.workspaceId === workspace.id &&
          workspace.sessions.some((row) => row.id === previous.sessionId)
        ) {
          sessionId = previous.sessionId;
        } else {
          sessionId = workspace.sessions[0]?.id ?? "";
        }
        const view = { workspaceId: workspace.id, sessionId };
        views.set(client.config.id, view);
        sendClientEvent(client.config.id, {
          type: "viewChanged",
          view,
          timestamp: new Date().toISOString(),
        });
        writeJson(response, 200, { version: API_VERSION, view });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/transcript") {
        const catalog = await catalogFor(client);
        const view = viewFor(client, catalog);
        if (!selectedSession(catalog, view)) {
          writeJson(response, 200, {
            version: API_VERSION,
            workspaceId: view.workspaceId,
            sessionId: view.sessionId,
            transcript: null,
          });
          return;
        }
        const sessionRef = { workspaceId: view.workspaceId, sessionId: view.sessionId };
        const transcript = await config.adapter.getTranscript(sessionRef);
        const safeTranscript = transcript
          ? sanitizeTranscript(transcript, sessionRef, attachmentRefs)
          : (clearAttachmentRefsForSession(sessionRef, attachmentRefs), null);
        writeJson(response, 200, {
          version: API_VERSION,
          workspaceId: view.workspaceId,
          sessionId: view.sessionId,
          transcript: safeTranscript,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/session/prompt") {
        const body = await readJsonObject(request, MAX_BODY_BYTES);
        exactKeys(body, ["text"]);
        if (
          typeof body.text !== "string" ||
          body.text.trim().length === 0 ||
          body.text.includes("\0") ||
          Buffer.byteLength(body.text, "utf8") > MAX_PROMPT_BYTES
        ) {
          throw new HttpError(
            400,
            "invalid_prompt",
            "The prompt must contain 1 to 131072 UTF-8 bytes.",
          );
        }

        const catalog = await catalogFor(client);
        const view = viewFor(client, catalog);
        if (!selectedSession(catalog, view))
          throw new HttpError(409, "session_required", "Select a native session first.");
        const sessionRef = { workspaceId: view.workspaceId, sessionId: view.sessionId };
        await config.adapter.submitPrompt({
          clientId: client.config.id,
          sessionRef,
          text: body.text,
        });
        writeJson(response, 202, { version: API_VERSION, ok: true, sessionRef });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/session/cancel") {
        const catalog = await catalogFor(client);
        const view = viewFor(client, catalog);
        if (!selectedSession(catalog, view))
          throw new HttpError(409, "session_required", "Select a native session first.");
        const sessionRef = { workspaceId: view.workspaceId, sessionId: view.sessionId };
        await config.adapter.cancelRun({ clientId: client.config.id, sessionRef });
        writeJson(response, 200, { version: API_VERSION, ok: true, sessionRef });
        return;
      }
      const attachmentMatch = /^\/v1\/attachments\/([A-Za-z0-9_-]{1,128})$/u.exec(url.pathname);
      if (request.method === "GET" && attachmentMatch) {
        if (!config.adapter.readAttachment) {
          throw new HttpError(404, "attachment_not_found", "Attachment downloads are disabled.");
        }
        const catalog = await catalogFor(client);
        const view = viewFor(client, catalog);
        if (!selectedSession(catalog, view))
          throw new HttpError(409, "session_required", "Select a native session first.");
        const sessionRef = { workspaceId: view.workspaceId, sessionId: view.sessionId };
        const entry = attachmentRefs.get(attachmentMatch[1]!);
        if (!entry || entry.sessionKey !== sessionKey(sessionRef)) {
          throw new HttpError(404, "attachment_not_found", "The attachment is not available.");
        }
        const attachment = await config.adapter.readAttachment(sessionRef, entry.reference);
        if (!attachment)
          throw new HttpError(404, "attachment_not_found", "The attachment is not available.");
        if (
          !(attachment.bytes instanceof Uint8Array) ||
          attachment.bytes.byteLength > MAX_ATTACHMENT_BYTES
        ) {
          throw new HttpError(
            413,
            "attachment_too_large",
            "The attachment exceeds its size limit.",
          );
        }
        const bytes = Buffer.from(
          attachment.bytes.buffer,
          attachment.bytes.byteOffset,
          attachment.bytes.byteLength,
        );
        response.writeHead(200, {
          "Content-Disposition": 'attachment; filename="' + safeFileName(attachment.name) + '"',
          "Content-Length": String(bytes.byteLength),
          "Content-Type": safeMimeType(attachment.mimeType),
          "X-Content-Type-Options": "nosniff",
        });
        response.end(bytes);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/events") {
        if (
          !request.headers.accept
            ?.split(",")
            .some((value) => value.trim().startsWith("text/event-stream"))
        ) {
          throw new HttpError(
            406,
            "event_stream_required",
            "Accept: text/event-stream is required.",
          );
        }
        const catalog = await catalogFor(client);
        const view = viewFor(client, catalog);
        const forClient = [...streams].filter(
          (stream) => stream.clientId === client.config.id,
        ).length;
        if (streams.size >= MAX_SSE_TOTAL || forClient >= MAX_SSE_PER_CLIENT) {
          throw new HttpError(
            429,
            "too_many_event_streams",
            "The event-stream limit has been reached.",
          );
        }
        response.writeHead(200, {
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        });
        response.write("retry: 2000\n\n");
        const stream: SseConnection = {
          clientId: client.config.id,
          response,
          heartbeat: setInterval(() => {
            if (response.writableLength > MAX_SSE_BUFFER) {
              response.end();
              removeStream(stream);
            } else {
              response.write(": keep-alive\n\n");
            }
          }, 15_000),
        };
        stream.heartbeat.unref?.();
        streams.add(stream);
        response.on("close", () => removeStream(stream));
        sendEvent(stream, { type: "ready", view, timestamp: new Date().toISOString() });
        return;
      }
      throw new HttpError(404, "not_found", "The requested remote session route was not found.");
    } catch (error) {
      writeError(response, error);
    }
  };

  server = createServer(
    { maxHeaderSize: 16 * 1024, headersTimeout: 10_000, requestTimeout: 30_000 },
    (request, response) => {
      void handle(request, response).catch((error: unknown) => writeError(response, error));
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: HOST, port, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === "string") {
    unsubscribe();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("The remote API did not bind to a loopback TCP port.");
  }

  return {
    origin: originFor(address.port),
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      unsubscribe();
      for (const stream of streams) {
        stream.response.end();
        removeStream(stream);
      }
      closePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return closePromise;
    },
  };
}
