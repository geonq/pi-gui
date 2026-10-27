import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

test("Windows paints its startup shell while the selected extension is still loading", async () => {
  test.skip(process.platform !== "win32", "Windows launch-frame flow");
  const root = await mkdtemp(join(tmpdir(), "pegasus-startup-gate-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const gate = join(root, "continue");
  const started = join(root, "started");
  const extension = join(root, "slow-extension.mjs");
  await writeFile(
    extension,
    [
      'import {watch,existsSync} from "node:fs";',
      'import {writeFile} from "node:fs/promises";',
      "export default async () => {",
      " await writeFile(" + JSON.stringify(started) + ',"started");',
      " await new Promise(resolve => {const watcher=watch(" +
        JSON.stringify(root) +
        ",()=>{if(existsSync(" +
        JSON.stringify(gate) +
        ")){watcher.close();resolve();}});if(existsSync(" +
        JSON.stringify(gate) +
        ")){watcher.close();resolve();}});",
      "};",
    ].join("\n"),
  );
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ extensions: [extension], enabledModels: [] }),
  );
  const h = await launchDesktop(await makeUserDataDir(), {
    agentDir,
    initialWorkspaces: [await makeWorkspace("startup-shell")],
    testMode: "foreground",
  });
  try {
    const shell = await h.electronApp.firstWindow();
    await expect.poll(() => readFile(started, "utf8").catch(() => "")).toBe("started");
    await expect(shell.getByRole("status")).toHaveText("Opening your workspace...");
    await expect(readFile(gate)).rejects.toMatchObject({ code: "ENOENT" });
    await shell.screenshot({ path: test.info().outputPath("loading-shell.png") });
    await writeFile(gate, "continue");
    const p = await h.firstWindow();
    await expect(
      p.getByRole("complementary").getByRole("button", { name: "New chat", exact: true }),
    ).toBeVisible();
    await expect(p.getByText("Opening your workspace...", { exact: true })).toHaveCount(0);
  } finally {
    await writeFile(gate, "continue");
    await h.close();
  }
});
