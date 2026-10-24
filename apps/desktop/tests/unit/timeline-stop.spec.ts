import { expect, test } from "@playwright/test";
import { sessionKey, type SessionDriverEvent } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import { applyTimelineEvent } from "../../electron/conversation/app-store-timeline";

const sessionRef = { workspaceId: "workspace", sessionId: "session" };

function runtimeState(): Parameters<typeof applyTimelineEvent>[2] {
  return {
    activeAssistantMessageBySession: new Map(),
    pendingAssistantMessageBySession: new Map(),
    activeWorkingActivityBySession: new Map(),
    extensionToolLabels: () => new Map(),
    runningSinceBySession: new Map(),
    runMetricsBySession: new Map(),
  };
}

function updated(status: "running" | "idle", timestamp: string): SessionDriverEvent {
  return {
    type: "sessionUpdated",
    sessionRef,
    timestamp,
    snapshot: {
      ref: sessionRef,
      status,
      ...(status === "running" ? { runningRunId: "run-1" } : {}),
    },
  } as unknown as SessionDriverEvent;
}

const rows = (transcript: Map<string, readonly TranscriptMessage[]>) =>
  (transcript.get(sessionKey(sessionRef)) ?? []).map((row) =>
    row.kind === "activity" ? `${row.label}${row.tone ? ` (${row.tone})` : ""}` : row.kind,
  );

test("stopping a prompt ends its Thinking pill and marks the turn Stopped", () => {
  const transcript = new Map<string, readonly TranscriptMessage[]>();
  const state = runtimeState();
  applyTimelineEvent(transcript, updated("running", "2026-10-24T17:00:00.000Z"), state);
  expect(rows(transcript)).toEqual(["Thinking… (working)"]);
  // The driver reports a cancellation with this idle update alone.
  applyTimelineEvent(transcript, updated("idle", "2026-10-24T17:00:05.000Z"), state);
  expect(rows(transcript)).toEqual(["Stopped"]);
  // A second idle update (the run's own end) adds nothing more.
  applyTimelineEvent(transcript, updated("idle", "2026-10-24T17:00:06.000Z"), state);
  expect(rows(transcript)).toEqual(["Stopped"]);
});

test("a run that finishes normally is not marked Stopped", () => {
  const transcript = new Map<string, readonly TranscriptMessage[]>();
  const state = runtimeState();
  applyTimelineEvent(transcript, updated("running", "2026-10-24T17:00:00.000Z"), state);
  applyTimelineEvent(
    transcript,
    {
      type: "runCompleted",
      sessionRef,
      timestamp: "2026-10-24T17:00:04.000Z",
      snapshot: { ref: sessionRef, status: "idle" },
    } as unknown as SessionDriverEvent,
    state,
  );
  applyTimelineEvent(transcript, updated("idle", "2026-10-24T17:00:04.000Z"), state);
  expect(rows(transcript).some((row) => row.startsWith("Thinking"))).toBe(false);
  expect(rows(transcript)).not.toContain("Stopped");
});
