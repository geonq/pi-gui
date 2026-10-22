import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createNamedThread,
  desktopShortcut,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  seedTranscriptMessages,
  selectSidePanel,
  waitForWorkspaceByPath,
  type DesktopHarness,
} from "../helpers/electron-app";
import { seedUsageSessions } from "../../../../examples/desktop-extensions/usage/test/seed-sessions";

// Screenshots every main GUI state (dark and light, wide and narrow) for visual
// review. Set PI_APP_GUI_STATES_DIR to keep the images. No provider is called:
// the running state comes from the test session-event hook.
const shotDir = process.env.PI_APP_GUI_STATES_DIR?.trim();

test("captures every main GUI state", async () => {
  test.setTimeout(300_000);
  if (shotDir) await mkdir(shotDir, { recursive: true });
  const workspacePath = await makeGitWorkspace("pi-ecosystem");
  const second = await makeWorkspace("a-workspace-with-a-much-longer-folder-name");
  const userDataDir = await makeUserDataDir();
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath, second],
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    // Real pi session files with known usage, so the Usage page has data to draw.
    await seedUsageSessions({ cwd: workspacePath, agentDir: join(userDataDir, "agent") });
    // Renderer screenshots cannot show OS glass, so review the opaque surfaces.
    await window.evaluate(() => window.piApp?.setEnableTransparency(false));

    for (const variant of ["dark", "light"] as const) {
      await resize(harness, 1480, 980);
      await setVariant(window, variant);
      await openNewThread(window);
      await shot(window, `${variant}-01-new-thread.png`);
      await window.getByRole("button", { name: "Toggle side panel" }).click();
      await shot(window, `${variant}-01b-agents-without-thread.png`);
      await window.getByRole("button", { name: "Toggle side panel" }).click();
      await window.locator(".new-thread__workspace").click();
      await shot(window, `${variant}-02-workspace-picker-open.png`);
      await window.keyboard.press("Escape");

      if (variant === "dark") {
        await createNamedThread(window, "Polish the desktop shell and verify every state");
        await seedTranscriptMessages(harness, window, {
          count: 4,
          textFactory: (index) =>
            index === 3
              ? 'Here is the change:\n\n```ts\nconst glass = { material: "acrylic", alpha: 0.6 };\n```\n\nAnd a list:\n\n- one\n- two'
              : `Message ${index + 1}: enough text to show how a normal paragraph wraps inside the transcript column at this width.`,
        });
      }
      await window.locator(".session-row").first().click();
      await window.getByTestId("composer").fill("Check the composer in this theme.");
      await shot(window, `${variant}-03-thread.png`);

      await setRunning(harness, window, true);
      await window.waitForTimeout(600);
      await shot(window, `${variant}-04-running.png`);
      await selectSidePanel(window, "Agents");
      await shot(window, `${variant}-04b-agents-running.png`);
      await setRunning(harness, window, false);

      await window.locator(".workspace-row").first().hover();
      await shot(window, `${variant}-05-workspace-row-hover.png`);
      await window.locator(".workspace-row__menu-button").first().click();
      await shot(window, `${variant}-06-workspace-menu.png`);
      await window.keyboard.press("Escape");
      await window.locator(".model-selector__badge").first().click();
      await shot(window, `${variant}-07-model-selector.png`);
      await window.keyboard.press("Escape");

      await selectSidePanel(window, "Review");
      await shot(window, `${variant}-08-review-panel.png`);
      await selectSidePanel(window, "Terminal");
      await window.waitForTimeout(800);
      await shot(window, `${variant}-09-terminal-panel.png`);
      await window.getByTestId("composer").focus();
      await window.keyboard.press(desktopShortcut("k"));
      await shot(window, `${variant}-10-command-palette.png`);
      await window.keyboard.press("Escape");

      await window.keyboard.press(desktopShortcut(","));
      await expect(window.getByTestId("settings-surface")).toBeVisible();
      for (const section of ["General", "Appearance", "Providers", "Models"]) {
        const button = window.getByRole("button", { name: section, exact: true });
        if (!(await button.count())) continue;
        await button.click();
        await shot(window, `${variant}-11-settings-${section.toLowerCase()}.png`);
      }
      await window.getByRole("button", { name: "Back to app" }).click();

      await window.getByTestId("sidebar-usage").click();
      await window.waitForTimeout(1800);
      await shot(window, `${variant}-13-usage.png`);
      await window.locator(".usage-account").nth(1).click();
      await window.waitForTimeout(1200);
      await shot(window, `${variant}-13b-usage-account.png`);
      await window.getByRole("button", { name: "Threads", exact: true }).first().click();
      await resize(harness, 760, 720);
      await shot(window, `${variant}-12-narrow.png`);
    }
  } finally {
    await harness.close();
  }
});

async function setVariant(window: Page, variant: "light" | "dark"): Promise<void> {
  await window.getByRole("button", { name: "Settings", exact: true }).click();
  await window.getByRole("button", { name: "Appearance", exact: true }).click();
  await window
    .getByRole("radio", { name: variant === "light" ? "Light" : "Dark", exact: true })
    .click();
  await expect
    .poll(() => window.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(variant === "dark");
  await window.getByRole("button", { name: "Back to app" }).click();
}

async function resize(harness: DesktopHarness, width: number, height: number): Promise<void> {
  await harness.electronApp.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height),
    { width, height },
  );
}

async function setRunning(harness: DesktopHarness, window: Page, running: boolean): Promise<void> {
  const state = await getDesktopState(window);
  const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
  const session = workspace?.sessions.find((entry) => entry.id === state.selectedSessionId);
  if (!workspace || !session) throw new Error("No selected session");
  const sessionRef = { workspaceId: workspace.id, sessionId: session.id };
  const now = new Date().toISOString();
  await emitTestSessionEvent(harness, {
    type: "sessionUpdated",
    sessionRef,
    timestamp: now,
    runId: "gui-states-run",
    snapshot: {
      ref: sessionRef,
      workspace: { workspaceId: workspace.id, path: workspace.path, displayName: workspace.name },
      title: session.title,
      status: running ? "running" : "idle",
      updatedAt: now,
      preview: session.preview ?? "",
      ...(running ? { runningRunId: "gui-states-run" } : {}),
    },
  });
}

async function shot(window: Page, name: string): Promise<void> {
  await window.waitForTimeout(200);
  if (shotDir) await window.screenshot({ path: join(shotDir, name) });
}
