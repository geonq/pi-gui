import { expect, test } from "@playwright/test";
import { sessionKey } from "@pi-gui/session-driver";
import type { TranscriptMessage } from "../../contracts/timeline-types";
import {
  appendAssistantDelta,
  appendThinkingDelta,
} from "../../electron/conversation/app-store-timeline";

const sessionRef = { workspaceId: "workspace", sessionId: "session" };

test("thinking deltas extend the open thinking row, skip blanks, and reopen after other rows", () => {
  const cache = new Map<string, readonly TranscriptMessage[]>();
  const active = new Map<string, string>();
  const read = () => cache.get(sessionKey(sessionRef)) ?? [];

  appendThinkingDelta(cache, sessionRef, "  ");
  expect(read()).toHaveLength(0);

  appendThinkingDelta(cache, sessionRef, "Plan: ");
  appendThinkingDelta(cache, sessionRef, "look.");
  expect(read().map((item) => item.kind)).toEqual(["thinking"]);
  expect(read()[0]).toMatchObject({ kind: "thinking", text: "Plan: look." });

  appendAssistantDelta(cache, active, sessionRef, "Reply.");
  appendThinkingDelta(cache, sessionRef, "More.");
  expect(read().map((item) => item.kind)).toEqual(["thinking", "message", "thinking"]);
  expect(read()[2]).toMatchObject({ text: "More." });
});
