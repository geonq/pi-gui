import { expect, test } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  createSessionViaIpc,
  seedTranscriptMessages,
  emitTestSessionEvent,
} from "../helpers/electron-app";

test("a hidden window survives repeated transcript growth, resize and zero-size layout", async () => {
  const h = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("hidden-layout")],
    testMode: "background",
  });
  try {
    const p = await h.firstWindow();
    const errors: string[] = [];
    p.on("pageerror", (error) => errors.push(error.message));
    const state = await p.evaluate(() => window.piApp!.getState());
    await createSessionViaIpc(p, state.selectedWorkspaceId!, "Hidden layout");
    const { sessionRef } = await seedTranscriptMessages(h, p, { count: 100 });
    for (let i = 0; i < 12; i++) {
      await h.electronApp.evaluate(
        ({ BrowserWindow }, width) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          window.hide();
          window.setSize(width, 800);
        },
        i % 2 ? 1000 : 800,
      );
      await p.getByTestId("timeline-pane").evaluate(
        (pane, hidden) => {
          pane.style.display = hidden ? "none" : "";
        },
        i % 2 === 0,
      );
      await emitTestSessionEvent(h, {
        type: "assistantDelta",
        sessionRef,
        timestamp: new Date().toISOString(),
        text: "Hidden stream row " + i + "\n",
        runId: "hidden-layout-run",
      });
    }
    await p.getByTestId("timeline-pane").evaluate((pane) => {
      pane.style.display = "";
    });
    await expect(p.getByTestId("timeline-pane")).toHaveAttribute("data-layout", "settled");
    await p.getByTestId("composer").fill("The window still accepts a complete draft.");
    await expect(p.getByTestId("composer")).toHaveValue(
      "The window still accepts a complete draft.",
    );
    expect(errors).toEqual([]);
  } finally {
    await h.close();
  }
});
