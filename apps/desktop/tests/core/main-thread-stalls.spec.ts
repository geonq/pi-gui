import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

test("logs a blocked main thread, where typing waits", async () => {
  const userDataDir = await makeUserDataDir();
  const h = await launchDesktop(userDataDir, {
    initialWorkspaces: [await makeWorkspace("main-thread-stalls")],
    testMode: "background",
  });
  try {
    await h.firstWindow();
    await h.electronApp.evaluate(() => {
      const until = Date.now() + 600;
      while (Date.now() < until) {
        // Hold the main thread the way a synchronous agent step would.
      }
    });
    const log = join(userDataDir, "logs", "main-thread-stalls.log");
    await expect
      .poll(async () => readFile(log, "utf8").catch(() => ""))
      .toMatch(/main thread blocked (5\d\d|6\d\d|7\d\d) ms\n {4}\d+ ms in /);
  } finally {
    await h.close();
  }
});
