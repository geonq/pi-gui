import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const TICK_MS = 100;
const REPORT_MS = 250;
const MAX_LINES = 5000;

/**
 * Logs every stretch the main thread was blocked. Keyboard and mouse input reach the window
 * through this thread, so each line is a moment typing or clicking could not get through.
 */
export function watchMainThreadStalls(logDirectory: string): void {
  const file = path.join(logDirectory, "main-thread-stalls.log");
  let expected = performance.now() + TICK_MS;
  let written = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    const blocked = now - expected;
    expected = now + TICK_MS;
    if (blocked < REPORT_MS || written >= MAX_LINES) return;
    written += 1;
    const line = `${new Date().toISOString()} main thread blocked ${Math.round(blocked)} ms\n`;
    mkdir(logDirectory, { recursive: true })
      .then(() => appendFile(file, line))
      .catch((error: unknown) => {
        console.error("[main] writing main-thread-stalls.log failed", error);
      });
  }, TICK_MS);
  timer.unref();
}
