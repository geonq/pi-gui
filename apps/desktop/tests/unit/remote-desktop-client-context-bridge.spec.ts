import { build } from "esbuild";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

test("remote client API crosses a sandboxed Electron contextBridge", async ({}, testInfo) => {
  const desktopRoot = resolve(__dirname, "../..");
  const fixtureRoot = resolve(__dirname, "../fixtures/remote-client-context-bridge");
  const preloadPath = testInfo.outputPath("remote-client-context-bridge-preload.cjs");
  const userDataPath = testInfo.outputPath("user-data");
  await build({
    entryPoints: [resolve(fixtureRoot, "preload.ts")],
    outfile: preloadPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
  });

  const args = [resolve(fixtureRoot, "main.cjs")];
  if (process.platform === "linux") {
    args.push("--disable-gpu", "--no-sandbox", "--disable-frame-rate-limit");
  }
  const electronApp = await electron.launch({
    args,
    cwd: desktopRoot,
    env: {
      ...process.env,
      PI_REMOTE_CONTEXT_BRIDGE_PRELOAD: preloadPath,
      PI_REMOTE_CONTEXT_BRIDGE_USER_DATA: userDataPath,
    },
  });
  try {
    const page = await electronApp.firstWindow();
    await page.waitForFunction(() => Boolean((window as Window & { piApp?: unknown }).piApp));
    const result = await page.evaluate(async () => {
      const api = (
        window as Window & {
          piApp?: {
            backend?: string;
            ping?: () => Promise<string>;
            getState?: () => Promise<{ themeMode?: string; composerDraft?: string }>;
          };
        }
      ).piApp;
      if (!api?.ping || !api.getState) return null;
      const state = await api.getState();
      return {
        hasOwnBackend: Object.prototype.hasOwnProperty.call(api, "backend"),
        backend: api.backend,
        ping: await api.ping(),
        themeMode: state.themeMode,
        composerDraft: state.composerDraft,
      };
    });
    expect(result).toEqual({
      hasOwnBackend: true,
      backend: "windows",
      ping: "pong",
      themeMode: "light",
      composerDraft: "",
    });
  } finally {
    await electronApp.close();
  }
});
