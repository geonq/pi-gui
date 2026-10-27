import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createSessionViaIpc,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedTranscriptMessages,
  selectSession,
  waitForTimelineLayout,
} from "../helpers/electron-app";

// Screenshots of the floating overlays on window glass: the slash menu over a transcript and a
// sidebar row tooltip. Set GLASS_SHOT_DIR to keep them; the window is shown without focus so it
// composites like the real app.
const shotDir = process.env.GLASS_SHOT_DIR?.trim();

test("floating overlays stay readable over the transcript", async () => {
  test.setTimeout(120_000);
  if (shotDir) await mkdir(shotDir, { recursive: true });
  const h = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("glass-overlays")],
    testMode: "background",
  });
  try {
    const p = await h.firstWindow();
    await h.electronApp.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.showInactive();
    });
    const state = await getDesktopState(p);
    for (const title of ["Glass sidebar row", "Glass probe"]) {
      await createSessionViaIpc(p, state.selectedWorkspaceId!, title);
    }
    await selectSession(p, "Glass probe");
    await seedTranscriptMessages(h, p, {
      count: 12,
      textFactory: (i) => `Line ${i}: ${"readable transcript text behind the menu ".repeat(8)}`,
    });
    await p.evaluate(() => window.piApp!.setEnableTransparency(true));
    await expect(p.locator(".enable-transparency")).toHaveCount(1);
    await waitForTimelineLayout(p);

    await p.getByTestId("composer").click();
    await p.keyboard.type("/");
    const menu = p.locator(".slash-menu");
    await expect(menu).toBeVisible();
    if (shotDir) await p.screenshot({ path: join(shotDir, "slash-menu.png") });
    await p.keyboard.press("Escape");
    await p.keyboard.press("Control+A");
    await p.keyboard.press("Backspace");

    const row = p.locator(".session-row").filter({ hasText: "Glass sidebar row" });
    await row.hover();
    await row.locator(".session-row__tooltip-wrap").hover();
    const tooltip = row.locator(".session-row__tooltip");
    await expect(tooltip).toHaveCSS("opacity", "1");
    if (shotDir) await p.screenshot({ path: join(shotDir, "sidebar-tooltip.png") });
  } finally {
    await h.close();
  }
});
