import type { BrowserWindow } from "electron";
import { expect, test } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedTranscriptMessages,
  emitTestSessionEvent,
  waitForTimelineLayout,
} from "../helpers/electron-app";
import { createThread } from "../helpers/session-event-test-helpers";
import { emitRunningEvent, emitCompletedEvent } from "../helpers/notification-events";

test("a minimized window renders streamed changes and accepts its draft after restore", async () => {
  const h = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("minimized-timeline")],
    testMode: "foreground",
    envOverrides: { PI_APP_TEST_NOTIFICATION_PERMISSION_STATUS: "granted" },
  });
  try {
    const p = await h.firstWindow();
    await h.focusWindow();
    const nativeWindow = await h.electronApp.browserWindow(p);
    const errors: string[] = [];
    p.on("pageerror", (error) => errors.push(error.message));
    const session = await createThread(p, "Minimized streaming");
    await seedTranscriptMessages(h, p, { count: 100 });
    const runId = await emitRunningEvent(h, session, "Minimized");
    // A focused renderer may precede the first native paint and ready-to-show.
    await waitForTimelineLayout(p);
    await nativeWindow.evaluate((window: BrowserWindow) => {
      setImmediate(() => window.minimize());
    });
    await expect
      .poll(() => nativeWindow.evaluate((window: BrowserWindow) => window.isMinimized()))
      .toBe(true);
    for (let i = 0; i < 20; i++) {
      await emitTestSessionEvent(h, {
        type: "assistantDelta",
        sessionRef: session.sessionRef,
        timestamp: new Date().toISOString(),
        runId,
        text: "Background stream line " + i + "\n",
      });
    }
    await emitCompletedEvent(h, session, "Minimized", runId);
    await expect
      .poll(() => nativeWindow.evaluate((window: BrowserWindow) => window.isMinimized()))
      .toBe(true);
    await h.focusWindow();
    await expect(p.locator(".timeline-item--assistant").last()).toContainText(
      "Background stream line 19",
    );
    const draft = "All characters survive after minimizing and restoring.";
    await p.getByTestId("composer").pressSequentially(draft, { delay: 15 });
    await expect(p.getByTestId("composer")).toHaveValue(draft);
    await p.screenshot({ path: test.info().outputPath("restored.png") });
    expect(errors).toEqual([]);
  } finally {
    await h.close();
  }
});
