import { app, dialog } from "electron";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyManagedLaunchEnvironment,
  DENIED_ENVIRONMENT_NAME,
  recordStartupError,
} from "./managed-launch-environment";

function requireOwnedPath(candidate: string, kind: "directory" | "file"): void {
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink() || realpathSync(candidate) !== candidate) {
    throw new Error("Unexpected managed launch path.");
  }
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error("Unexpected managed launch path.");
  }
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (DENIED_ENVIRONMENT_NAME.test(name)) delete env[name];
  }
  return env;
}

/** Finder launches of the managed Mac install use the same protected profile as the shell launcher. */
export function handOffManagedMacLaunch(): void {
  if (process.platform !== "darwin" || !app.isPackaged) return;
  if (process.env.PI_GUI_INTEGRATED_LAUNCH === "1") return;

  const piRoot = path.join(os.homedir(), "Pi");
  const appRoot = path.join(piRoot, "app");
  // The app and runtime stay in ~/Pi; the ecosystem (state, scripts) lives in ~/Arbeit on the Mac.
  const workRoot = path.join(os.homedir(), "Arbeit");
  const ecosystemRoot = path.join(workRoot, "pi-ecosystem");
  const scriptRoot = path.join(ecosystemRoot, "scripts");
  const launcher = path.join(scriptRoot, "Launch-PiGui.sh");
  const expectedBundle = path.join(appRoot, "Pegasus.app");
  const expectedExecutable = path.join(expectedBundle, "Contents", "MacOS", "Pegasus");
  const bundleRoot = path.resolve(path.dirname(process.execPath), "..", "..");

  try {
    if (bundleRoot !== expectedBundle || path.resolve(process.execPath) !== expectedExecutable) {
      throw new Error("The packaged app is outside the managed Pi install.");
    }
    for (const directory of [
      piRoot,
      appRoot,
      bundleRoot,
      path.join(bundleRoot, "Contents"),
      path.dirname(process.execPath),
      workRoot,
      ecosystemRoot,
      scriptRoot,
    ]) {
      requireOwnedPath(directory, "directory");
    }
    requireOwnedPath(process.execPath, "file");
    requireOwnedPath(launcher, "file");
    const output = execFileSync("/bin/sh", [launcher, "--prepare-only"], {
      cwd: ecosystemRoot,
      env: { ...sanitizedEnvironment(), PI_APP_PACKAGED_EXECUTABLE: process.execPath },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    });
    applyManagedLaunchEnvironment(output, {
      userDataDir: path.join(ecosystemRoot, ".state", "pi-gui"),
      agentDir: path.join(ecosystemRoot, ".state", "agent"),
    });
  } catch (error) {
    recordStartupError(ecosystemRoot, error);
    dialog.showErrorBox(
      "Pegasus could not start",
      "The managed Pi setup could not start. Review the private startup log in pi-ecosystem/.state.",
    );
    app.exit(1);
  }
}
