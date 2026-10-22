import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { launchDesktop, makeUserDataDir, makeWorkspace, seedAgentDir } from "../helpers/electron-app";

// Sweeps the pointer across the usage heatmap like a user scanning days, and reports frame rate.
test("usage heatmap hover frame rate", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [await makeWorkspace("heatmap-perf")],
    testMode: "foreground",
  });
  try {
    const window = await harness.firstWindow();
    await window.getByTestId("sidebar-usage").click();
    const cells = window.locator(".usage-heatmap .visx-heatmap-rect, .usage-heatmap .usage-heatmap__cell");
    await expect(cells.first()).toBeVisible();
    const box = (await window.locator(".usage-heatmap svg").first().boundingBox())!;
    await window.evaluate(() => {
      const w = window as unknown as { __frames: number[] };
      w.__frames = [];
      const tick = (t: number) => { w.__frames.push(t); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    // Three left-to-right passes over the grid rows, one pointer move per ~16 ms.
    const t0 = Date.now();
    for (const fraction of [0.55]) {
      for (let step = 0; step <= 30; step += 1) {
        await window.mouse.move(box.x + (box.width * step) / 30, box.y + box.height * fraction);
        await window.waitForTimeout(16);
      }
    }
    const stats = await window.evaluate(() => {
      const f = (window as unknown as { __frames: number[] }).__frames;
      const gaps = f.slice(1).map((t, i) => t - f[i]!).sort((a, b) => a - b);
      return { frames: f.length, seconds: (f.at(-1)! - f[0]!) / 1000, p50: gaps[Math.floor(gaps.length / 2)], p95: gaps[Math.floor(gaps.length * 0.95)], worst: gaps.at(-1) };
    });
    console.log("HEATMAP", JSON.stringify({ msPerMove: Math.round((Date.now() - t0) / 31), fps: Math.round(stats.frames / stats.seconds), ...stats, cells: await cells.count() }));
    await window.mouse.move(box.x + box.width * 0.97, box.y + box.height * 0.45);
    await window.waitForTimeout(400);
    await window.locator(".usage-heatmap").screenshot({ path: process.env.PROBE_SHOT ?? "heatmap.png" });
  } finally {
    await harness.close();
  }
});
