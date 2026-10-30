// Starts `codex app-server` for one rate-limit read off the main thread: Defender scans the large
// codex.exe inside CreateProcess, which held Pegasus's main thread (and input) for over a second.
import { parentPort, workerData } from "node:worker_threads";
import { readRateLimits } from "./codex-limits";

const { binary, home } = workerData as { readonly binary: string; readonly home: string };
readRateLimits(binary, home).then(
  (value) => parentPort?.postMessage({ value }),
  (error: unknown) =>
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) }),
);
