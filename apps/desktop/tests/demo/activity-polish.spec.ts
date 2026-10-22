import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createNamedThread,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
} from "../helpers/electron-app";

test("activity states and compact controls stay stable", async () => {
  test.setTimeout(120_000);
  const evidence = process.env.PI_ORB_EVIDENCE!;
  await mkdir(evidence, { recursive: true });
  const profile = await makeUserDataDir();
  const workspacePath = await makeWorkspace("prop-firm-bot-current");
  const harness = await launchDesktop(profile, {
    initialWorkspaces: [workspacePath],
    testMode: "foreground",
    recordVideoDir: join(evidence, "video"),
    recordVideoSize: { width: 1280, height: 900 },
  });
  try {
    const page = await harness.firstWindow();
    await openNewThread(page);
    await expect(page.getByRole("heading", { name: "Start a new chat." })).toBeVisible();
    await expect(page.locator(".new-thread__logo [data-orb-state=composing]")).toBeVisible();
    await expect(page.locator(".new-thread__open-folder")).toBeVisible();
    await page.screenshot({ path: join(evidence, "new-chat.png") });
    await createNamedThread(page, "Activity transition check");
    const state = await getDesktopState(page);
    const workspace = state.workspaces.find((w) => w.id === state.selectedWorkspaceId)!;
    const session = workspace.sessions.find((s) => s.id === state.selectedSessionId)!;
    const sessionRef = { workspaceId: workspace.id, sessionId: session.id };
    const timestamp = new Date().toISOString();
    await emitTestSessionEvent(harness, {
      type: "sessionUpdated",
      sessionRef,
      timestamp,
      snapshot: {
        ref: sessionRef,
        workspace: { workspaceId: workspace.id, path: workspace.path, displayName: workspace.name },
        title: session.title,
        status: "running",
        updatedAt: timestamp,
        runningRunId: "orb-proof",
        preview: "",
      },
    });
    await expect(page.locator(".running-activity [data-orb-state=solving]")).toBeVisible();
    for (const [toolName, orb] of [
      ["search_web", "searching"],
      ["run_command", "connecting"],
    ] as const) {
      await emitTestSessionEvent(harness, {
        type: "assistantActivity",
        sessionRef,
        timestamp,
        toolName,
      });
      await expect(page.locator(`.running-activity [data-orb-state=${orb}]`)).toBeVisible();
      await expect(page.locator(".timeline-tool")).toHaveCount(0);
    }
    for (const [toolName, orb] of [
      ["web_search", "searching"],
      ["bash", "connecting"],
      ["read", "connecting"],
      ["ask_user", "listening"],
    ] as const) {
      await emitTestSessionEvent(harness, {
        type: "toolStarted",
        sessionRef,
        timestamp,
        callId: toolName,
        toolName,
        input: {},
      });
      await expect(page.locator(`.running-activity [data-orb-state=${orb}]`)).toBeVisible();
      await expect(
        page.locator(`.timeline-activity--working [data-orb-state=${orb}]`),
      ).toBeVisible();
      await page.waitForTimeout(280);
      await expect(page.locator(".running-activity .state-orb canvas")).toHaveCount(1);
      await page.screenshot({ path: join(evidence, `${orb}-${toolName}.png`) });
      await emitTestSessionEvent(harness, {
        type: "toolFinished",
        sessionRef,
        timestamp,
        callId: toolName,
        success: true,
        output: "Done",
      });
    }
    await emitTestSessionEvent(harness, {
      type: "assistantDelta",
      sessionRef,
      timestamp,
      text: "The task is complete. This response should arrive without a flash or a new activity row.",
    });
    await expect(page.locator(".running-activity [data-orb-state=composing]")).toBeVisible();
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(evidence, "response.png") });
    await emitTestSessionEvent(harness, { type: "runCompleted", sessionRef, timestamp });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("button", { name: "Back to app", exact: true })).toBeVisible();
    await page.screenshot({ path: join(evidence, "back-alignment.png") });
    const customize = page.getByRole("button", { name: /Skills and extensions/ });
    await customize.click();
    for (const width of [1280, 900]) {
      await harness.electronApp.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]?.setSize(width, 850),
        width,
      );
      await expect(page.getByRole("button", { name: "New skill", exact: true })).toBeVisible();
      const fit = await page
        .getByRole("button", { name: "New skill", exact: true })
        .evaluate((el) => ({
          whiteSpace: getComputedStyle(el).whiteSpace,
          fits: el.scrollWidth <= el.clientWidth,
        }));
      expect(fit).toEqual({ whiteSpace: "nowrap", fits: true });
      const gap = await page.locator(".view-header").evaluate((el) => {
        const title = el.querySelector(".view-header__body")!.getBoundingClientRect();
        const actions = el.querySelector(".view-header__actions")!.getBoundingClientRect();
        return actions.top - title.bottom;
      });
      expect(gap).toBeLessThan(40);
      await page.screenshot({ path: join(evidence, `skills-${width}.png`) });
    }
  } finally {
    await harness.close();
  }
});
