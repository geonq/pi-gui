import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SignInStatus } from "../../contracts/usage";
import { parseClaudeAuthStatus, startSignInMonitor } from "../../electron/usage/sign-ins";

test("only explicit completed Claude status establishes a signed-out account", () => {
  expect(parseClaudeAuthStatus('{"loggedIn":true}')).toBe("ok");
  expect(parseClaudeAuthStatus('{"loggedIn":false}')).toBe("signed-out");
  for (const output of ["", "command failed", "{}", '{"loggedIn":"false"}', '{"loggedIn":false']) {
    expect(parseClaudeAuthStatus(output)).toBe("unknown");
  }
  expect(parseClaudeAuthStatus('{"loggedIn":false}', true)).toBe("unknown");
});

test("unknown checks never notify or clear the remembered real sign-out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pegasus-sign-in-status-"));
  const paths = { stateDir: dir, memoryFile: join(dir, "notices.json") };
  let state: SignInStatus["state"] = "unknown";
  const notified: string[] = [];
  const monitor = startSignInMonitor(paths, status => notified.push(status.state), async () => [{ id: "claude-code-account-1", name: "Claude", state }]);
  try {
    await monitor.checkNow();
    expect(notified).toEqual([]);
    expect(monitor.current()[0]?.state).toBe("unknown");
    state = "signed-out";
    await monitor.checkNow();
    state = "unknown";
    await monitor.checkNow();
    state = "signed-out";
    await monitor.checkNow();
    expect(notified).toEqual(["signed-out"]);
    state = "ok";
    await monitor.checkNow();
    state = "signed-out";
    await monitor.checkNow();
    expect(notified).toEqual(["signed-out", "signed-out"]);
  } finally {
    monitor.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
