import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchDesktopByExecutable, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

test("profiles packaged startup with and without the managed native extension", async () => {
  test.setTimeout(180_000);
  const executable = process.env.PI_GUI_EXECUTABLE;
  const extension = process.env.PI_GUI_EXTENSION_PATH;
  if (!executable || !extension)
    throw new Error("Set PI_GUI_EXECUTABLE and PI_GUI_EXTENSION_PATH for startup profiling");
  const samples: Array<{
    nativeExtension: boolean;
    elapsedMs: number;
    logs: string[];
    stalls: string;
  }> = [];
  for (const enabled of [false, true]) {
    const userData = await makeUserDataDir("pegasus-startup-profile-");
    const privateRoot = await mkdtemp(join(tmpdir(), "pegasus-startup-agent-"));
    const agentDir = join(privateRoot, "agent");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "auth.json"), "{}");
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ extensions: enabled ? [extension] : [], enabledModels: [] }),
    );
    const logs: string[] = [];
    const started = Date.now();
    const h = await launchDesktopByExecutable(executable, userData, {
      agentDir,
      initialWorkspaces: [await makeWorkspace("startup-profile")],
      envOverrides: {
        PI_APP_TEST_MODE: undefined,
        PI_GUI_INTEGRATED_LAUNCH: "1",
        PI_APP_STARTUP_TRACE: "1",
      },
    });
    h.electronApp.on("console", (message) => logs.push(message.text()));
    h.electronApp.process().stdout?.on("data", (chunk) => logs.push(String(chunk)));
    h.electronApp.process().stderr?.on("data", (chunk) => logs.push(String(chunk)));
    try {
      const p = await h.firstWindow();
      await expect(
        p.getByRole("complementary").getByRole("button", { name: "New chat", exact: true }),
      ).toBeVisible();
      const elapsedMs = Date.now() - started;
      await p.screenshot({
        path: test.info().outputPath(enabled ? "native-startup.png" : "plain-startup.png"),
      });
      samples.push({
        nativeExtension: enabled,
        elapsedMs,
        logs,
        stalls: await readFile(join(userData, "logs", "main-thread-stalls.log"), "utf8").catch(
          () => "",
        ),
      });
    } finally {
      await h.close();
    }
  }
  await writeFile(test.info().outputPath("startup-profile.json"), JSON.stringify(samples, null, 2));
  console.log(
    samples.map((sample) => ({
      nativeExtension: sample.nativeExtension,
      elapsedMs: sample.elapsedMs,
    })),
  );
});
