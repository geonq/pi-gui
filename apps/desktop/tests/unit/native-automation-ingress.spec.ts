import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef, SessionSnapshot } from "@pi-gui/session-driver";
import type { DesktopAppState, WorkspaceRecord } from "../../contracts/desktop-state";
import {
  startAutomationIngress,
  type NativeAutomationIngress,
  type NativeAutomationStore,
} from "../../electron/automation/native-automation-ingress";

interface FakeStoreOptions {
  readonly blocked?: boolean;
  readonly blockCancellation?: boolean;
}

function fakeStore(options: FakeStoreOptions = {}) {
  const workspaceId = "workspace-a";
  const workspacePath = process.cwd();
  const sessions: WorkspaceRecord["sessions"][number][] = [];
  const workspaces: WorkspaceRecord[] = [
    {
      id: workspaceId,
      name: "Test workspace",
      path: workspacePath,
      lastOpenedAt: new Date().toISOString(),
      kind: "primary",
      sessions,
    },
    {
      id: "workspace-private",
      name: "Private other workspace",
      path: join(workspacePath, "not-for-response"),
      lastOpenedAt: new Date().toISOString(),
      kind: "primary",
      sessions: [
        {
          id: "unrelated-session",
          title: "Unrelated private title",
          updatedAt: new Date().toISOString(),
          preview: "Unrelated prompt preview",
          status: "running",
          hasUnseenUpdate: false,
        },
      ],
    },
  ];
  const statusBySession = new Map<string, "idle" | "running" | "failed">();
  const runningBySession = new Map<string, string>();
  const eventListeners = new Set<(event: SessionDriverEvent) => void>();
  const submitted: Array<{ sessionRef: SessionRef; text: string }> = [];
  const pending: Array<() => void> = [];
  const pendingCancellations: Array<() => void> = [];
  const startedWaiters: Array<{ count: number; resolve: () => void }> = [];
  const cancellationWaiters: Array<{ count: number; resolve: () => void }> = [];

  const snapshot = (
    ref: SessionRef,
    status: "idle" | "running" | "failed",
    runId?: string,
  ): SessionSnapshot => ({
    ref,
    workspace: { workspaceId: ref.workspaceId, path: workspacePath },
    title: "Automation session",
    status,
    updatedAt: new Date().toISOString(),
    ...(runId ? { runningRunId: runId } : {}),
  });
  const emit = (event: SessionDriverEvent) => {
    for (const listener of eventListeners) listener(event);
  };
  const complete = (ref: SessionRef, text = "native reply") => {
    const runId = runningBySession.get(ref.sessionId) ?? "native-run";
    emit({
      type: "assistantDelta",
      sessionRef: ref,
      timestamp: new Date().toISOString(),
      runId,
      text,
    });
    statusBySession.set(ref.sessionId, "idle");
    runningBySession.delete(ref.sessionId);
    emit({
      type: "runCompleted",
      sessionRef: ref,
      timestamp: new Date().toISOString(),
      runId,
      snapshot: snapshot(ref, "idle"),
    });
  };

  const store: NativeAutomationStore = {
    async getState() {
      return { workspaces } as Pick<DesktopAppState, "workspaces">;
    },
    async createSession(input) {
      const ref = { workspaceId: input.workspaceId, sessionId: `session-${sessions.length + 1}` };
      sessions.push({
        id: ref.sessionId,
        title: input.title ?? "Automation session",
        updatedAt: new Date().toISOString(),
        preview: "",
        status: "idle",
        hasUnseenUpdate: false,
      });
      statusBySession.set(ref.sessionId, "idle");
      return ref;
    },
    async ensureSessionReady(ref) {
      const status = statusBySession.get(ref.sessionId);
      if (!status) return undefined;
      return {
        status,
        ...(runningBySession.get(ref.sessionId)
          ? { runningRunId: runningBySession.get(ref.sessionId) }
          : {}),
      };
    },
    async submitComposer(sessionRef, text) {
      submitted.push({ sessionRef, text });
      const runId = `native-${submitted.length}`;
      statusBySession.set(sessionRef.sessionId, "running");
      runningBySession.set(sessionRef.sessionId, runId);
      emit({
        type: "sessionUpdated",
        sessionRef,
        timestamp: new Date().toISOString(),
        runId,
        snapshot: snapshot(sessionRef, "running", runId),
      });
      for (let index = startedWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = startedWaiters[index]!;
        if (submitted.length >= waiter.count) {
          startedWaiters.splice(index, 1);
          waiter.resolve();
        }
      }
      if (options.blocked) {
        return new Promise<void>((resolve) => {
          pending.push(() => {
            complete(sessionRef);
            resolve();
          });
        });
      }
      complete(sessionRef);
    },
    async cancelCurrentRun(sessionRef) {
      if (options.blockCancellation) {
        return new Promise<void>((resolve) => {
          pendingCancellations.push(() => {
            complete(sessionRef, "cancelled");
            resolve();
          });
          for (let index = cancellationWaiters.length - 1; index >= 0; index -= 1) {
            const waiter = cancellationWaiters[index]!;
            if (pendingCancellations.length >= waiter.count) {
              cancellationWaiters.splice(index, 1);
              waiter.resolve();
            }
          }
        });
      }
      complete(sessionRef, "cancelled");
    },
    subscribeToSessionEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  };

  return {
    store,
    submitted,
    pending,
    pendingCancellations,
    waitForStarted(count: number) {
      if (submitted.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => startedWaiters.push({ count, resolve }));
    },
    waitForCancellation(count: number) {
      if (pendingCancellations.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => cancellationWaiters.push({ count, resolve }));
    },
  };
}

async function ingressFixture(options: FakeStoreOptions = {}) {
  const userDataDir = await mkdtemp(join(tmpdir(), "pi-native-ingress-"));
  const store = fakeStore(options);
  const ingress = await startAutomationIngress({
    store: store.store,
    userDataDir,
    config: {
      loadRoutes: async () => ({
        "discord/guild/channel": {
          workspacePath: process.cwd(),
          title: "Discord automation",
          allowThreads: true,
        },
      }),
      threadRoutePrefixes: ["discord/guild/channel"],
    },
  });
  return {
    ...store,
    ingress,
    userDataDir,
    async cleanup() {
      await ingress.close();
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

function request(
  ingress: NativeAutomationIngress,
  path: string,
  options: { readonly method?: string; readonly body?: unknown; readonly authorize?: boolean } = {},
) {
  return fetch(`${ingress.origin}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.authorize === false ? {} : { authorization: `Bearer ${ingress.token}` }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

test("native ingress authenticates, scopes routes, deduplicates messages, and returns only native run output", async () => {
  const fixture = await ingressFixture();
  const updates: Array<{ runId: string; status: string }> = [];
  fixture.ingress.onRunUpdate((run) => updates.push({ runId: run.runId, status: run.status }));
  try {
    const unauthenticated = await request(fixture.ingress, "/v1/runs", {
      method: "POST",
      body: { routeId: "discord/guild/channel", messageId: "m-0", text: "Hello" },
      authorize: false,
    });
    expect(unauthenticated.status).toBe(401);

    const slashCommand = await request(fixture.ingress, "/v1/runs", {
      method: "POST",
      body: { routeId: "discord/guild/channel", messageId: "m-slash", text: " /settings" },
    });
    expect(slashCommand.status).toBe(400);

    const unauthorizedRoute = await request(fixture.ingress, "/v1/runs", {
      method: "POST",
      body: { routeId: "outside/route", messageId: "m-outside", text: "Hello" },
    });
    expect(unauthorizedRoute.status).toBe(403);

    const body = {
      routeId: "discord/guild/channel",
      messageId: "m-1",
      text: "Please summarize this.",
    };
    const accepted = await request(fixture.ingress, "/v1/runs", { method: "POST", body });
    expect(accepted.status).toBe(202);
    const acceptedRun = (await accepted.json()) as {
      runId: string;
      status: string;
      messageId?: string;
    };
    expect(acceptedRun.status).toBe("queued");
    expect(acceptedRun.messageId).toBeUndefined();

    const [duplicate, concurrentDuplicate] = await Promise.all([
      request(fixture.ingress, "/v1/runs", { method: "POST", body }),
      request(fixture.ingress, "/v1/runs", { method: "POST", body }),
    ]);
    expect([duplicate.status, concurrentDuplicate.status].sort()).toEqual([200, 200]);
    const duplicateRun = (await duplicate.json()) as { runId: string; deduplicated: boolean };
    const concurrentDuplicateRun = (await concurrentDuplicate.json()) as {
      runId: string;
      deduplicated: boolean;
    };
    expect(duplicateRun.runId).toBe(acceptedRun.runId);
    expect(duplicateRun.deduplicated).toBe(true);
    expect(concurrentDuplicateRun.runId).toBe(acceptedRun.runId);
    expect(concurrentDuplicateRun.deduplicated).toBe(true);
    await expect
      .poll(() =>
        updates.some(
          (update) => update.runId === acceptedRun.runId && update.status === "completed",
        ),
      )
      .toBe(true);
    expect(fixture.submitted).toEqual([
      {
        sessionRef: { workspaceId: "workspace-a", sessionId: "session-1" },
        text: "Please summarize this.",
      },
    ]);
    expect(
      updates.some((update) => update.runId === acceptedRun.runId && update.status === "completed"),
    ).toBe(true);

    const runResponse = await request(fixture.ingress, `/v1/runs/${acceptedRun.runId}`);
    const run = (await runResponse.json()) as Record<string, unknown>;
    expect(run.status).toBe("completed");
    expect(run.text).toBe("native reply");
    expect(JSON.stringify(run)).not.toContain("provider");

    const listResponse = await request(
      fixture.ingress,
      "/v1/runs?routeId=discord%2Fguild%2Fchannel",
    );
    const list = (await listResponse.json()) as {
      runs: Array<{ runId: string }>;
      nativeSessions: Array<{ id: string; status: string }>;
      nativeSessionCount: number;
    };
    expect(list.runs[0]?.runId).toBe(acceptedRun.runId);
    expect(list.nativeSessions).toEqual([{ id: "session-1", status: "idle" }]);
    expect(list.nativeSessionCount).toBe(1);
    const serializedList = JSON.stringify(list);
    expect(serializedList).not.toContain("Unrelated private title");
    expect(serializedList).not.toContain("not-for-response");
    expect(serializedList).not.toContain("Unrelated prompt preview");
  } finally {
    await fixture.cleanup();
  }
});

test("configured Discord thread routes get separate visible native sessions", async () => {
  const fixture = await ingressFixture();
  try {
    for (const [routeId, messageId, text] of [
      ["discord/guild/channel", "base-message", "Base work"],
      ["discord/guild/channel/thread/123456", "thread-message", "Thread work"],
    ] as const) {
      const response = await request(fixture.ingress, "/v1/runs", {
        method: "POST",
        body: { routeId, messageId, text },
      });
      expect(response.status).toBe(202);
    }
    await fixture.waitForStarted(2);
    expect(fixture.submitted.map((entry) => entry.text)).toEqual(["Base work", "Thread work"]);
    expect(fixture.submitted[0]!.sessionRef).not.toEqual(fixture.submitted[1]!.sessionRef);
    const list = await request(
      fixture.ingress,
      "/v1/runs?routeId=discord%2Fguild%2Fchannel%2Fthread%2F123456",
    );
    expect(list.status).toBe(200);
  } finally {
    await fixture.cleanup();
  }
});

test("each route runs one prompt at a time while another eligible route can use free capacity", async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pi-native-route-serial-"));
  const store = fakeStore({ blocked: true });
  const routeIds = ["route-a", "route-b", "route-c"];
  const ingress = await startAutomationIngress({
    store: store.store,
    userDataDir,
    config: {
      loadRoutes: async () =>
        Object.fromEntries(routeIds.map((routeId) => [routeId, { workspacePath: process.cwd() }])),
    },
  });
  try {
    for (const [routeId, messageId] of [
      ["route-a", "a-1"],
      ["route-b", "b-1"],
      ["route-a", "a-2"],
    ] as const) {
      const response = await request(ingress, "/v1/runs", {
        method: "POST",
        body: { routeId, messageId, text: `Task ${messageId}` },
      });
      expect(response.status).toBe(202);
    }
    await store.waitForStarted(2);
    expect(store.submitted.map((entry) => entry.text)).toEqual(["Task a-1", "Task b-1"]);

    const routeC = await request(ingress, "/v1/runs", {
      method: "POST",
      body: { routeId: "route-c", messageId: "c-1", text: "Task c-1" },
    });
    expect(routeC.status).toBe(202);

    // Completing route B frees one global slot, but route A's second message stays behind A1.
    store.pending[1]!();
    await store.waitForStarted(3);
    expect(store.submitted.map((entry) => entry.text)).toEqual([
      "Task a-1",
      "Task b-1",
      "Task c-1",
    ]);
    expect(store.submitted[0]!.sessionRef).not.toEqual(store.submitted[1]!.sessionRef);
    expect(store.submitted[2]!.sessionRef).not.toEqual(store.submitted[0]!.sessionRef);

    store.pending[2]!();
    const routeC2 = await request(ingress, "/v1/runs", {
      method: "POST",
      body: { routeId: "route-c", messageId: "c-2", text: "Task c-2" },
    });
    expect(routeC2.status).toBe(202);
    await store.waitForStarted(4);
    expect(store.submitted.map((entry) => entry.text)).toEqual([
      "Task a-1",
      "Task b-1",
      "Task c-1",
      "Task c-2",
    ]);

    store.pending[3]!();
    await Promise.resolve();

    store.pending[0]!();
    await store.waitForStarted(5);
    expect(store.submitted[4]).toEqual({
      sessionRef: store.submitted[0]!.sessionRef,
      text: "Task a-2",
    });
  } finally {
    await ingress.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("queue is bounded, active threads are serialized by route, and queued work can be cancelled", async () => {
  const fixture = await ingressFixture({ blocked: true });
  const routeIds = Array.from({ length: 15 }, (_, index) => `route-${index}`);
  const config = {
    loadRoutes: async () =>
      Object.fromEntries(routeIds.map((routeId) => [routeId, { workspacePath: process.cwd() }])),
  };
  const routeIngress = await startAutomationIngress({
    store: fixture.store,
    userDataDir: join(fixture.userDataDir, "queue-test"),
    config,
  });
  try {
    const accepted: Array<{ runId: string; status: string }> = [];
    for (const routeId of routeIds.slice(0, 14)) {
      const response = await request(routeIngress, "/v1/runs", {
        method: "POST",
        body: { routeId, messageId: `message-${routeId}`, text: `Task ${routeId}` },
      });
      expect(response.status).toBe(202);
      accepted.push((await response.json()) as { runId: string; status: string });
    }
    await fixture.waitForStarted(2);
    expect(fixture.submitted).toHaveLength(2);

    const full = await request(routeIngress, "/v1/runs", {
      method: "POST",
      body: { routeId: routeIds[14], messageId: "message-full", text: "Must be rejected" },
    });
    expect(full.status).toBe(429);

    const cancelled = await request(routeIngress, `/v1/runs/${accepted[13]!.runId}/cancel`, {
      method: "POST",
    });
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { run: { status: string } }).run.status).toBe("cancelled");

    const next = await request(routeIngress, "/v1/runs", {
      method: "POST",
      body: {
        routeId: routeIds[14],
        messageId: "message-next",
        text: "Accepted after cancellation",
      },
    });
    expect(next.status).toBe(202);
  } finally {
    await routeIngress.close();
    await fixture.cleanup();
  }
});

test("timeout requests native cancellation but holds capacity until a terminal event arrives", async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), "pi-native-timeout-"));
  const store = fakeStore({ blocked: true, blockCancellation: true });
  const routeIds = ["timeout-a", "timeout-b", "timeout-c"];
  const ingress = await startAutomationIngress({
    store: store.store,
    userDataDir,
    config: {
      timeoutMs: 250,
      loadRoutes: async () =>
        Object.fromEntries(routeIds.map((routeId) => [routeId, { workspacePath: process.cwd() }])),
    },
  });
  try {
    const runIds: string[] = [];
    for (const routeId of routeIds) {
      const response = await request(ingress, "/v1/runs", {
        method: "POST",
        body: { routeId, messageId: `message-${routeId}`, text: `Task ${routeId}` },
      });
      expect(response.status).toBe(202);
      runIds.push(((await response.json()) as { runId: string }).runId);
    }
    await store.waitForStarted(2);
    await store.waitForCancellation(1);
    expect(store.submitted).toHaveLength(2);

    const timedOutBeforeAck = await request(ingress, `/v1/runs/${runIds[0]!}`);
    expect(((await timedOutBeforeAck.json()) as { status: string }).status).toBe("running");

    // The cancellation call itself does not release capacity; a native terminal event does.
    store.pendingCancellations[0]!();
    await store.waitForStarted(3);
    expect(store.submitted).toHaveLength(3);
    expect(store.submitted[2]!.text).toBe("Task timeout-c");
    const timedOutAfterAck = await request(ingress, `/v1/runs/${runIds[0]!}`);
    const run = (await timedOutAfterAck.json()) as { status: string; error?: string };
    expect(run.status).toBe("failed");
    expect(run.error).toContain("time limit");
  } finally {
    await ingress.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("restart marks accepted/running work interrupted without replaying or persisting prompts", async () => {
  const fixture = await ingressFixture({ blocked: true });
  const messageText = "Private user prompt: do not persist this";
  try {
    const response = await request(fixture.ingress, "/v1/runs", {
      method: "POST",
      body: { routeId: "discord/guild/channel", messageId: "restart-message", text: messageText },
    });
    const accepted = (await response.json()) as { runId: string };
    await fixture.waitForStarted(1);

    const durable = await readFile(join(fixture.userDataDir, "native-automation.json"), "utf8");
    expect(durable).not.toContain(messageText);
    await fixture.ingress.close();

    const restartedStore = fakeStore();
    const restarted = await startAutomationIngress({
      store: restartedStore.store,
      userDataDir: fixture.userDataDir,
      config: {
        loadRoutes: async () => ({
          "discord/guild/channel": { workspacePath: process.cwd() },
        }),
      },
    });
    try {
      const runResponse = await request(restarted, `/v1/runs/${accepted.runId}`);
      const run = (await runResponse.json()) as { status: string; text?: string };
      expect(run.status).toBe("interrupted");
      expect(run.text).toBeUndefined();
      expect(restartedStore.submitted).toHaveLength(0);
    } finally {
      await restarted.close();
    }
  } finally {
    await fixture.cleanup();
  }
});
