import { app, dialog } from "electron";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { applyManagedLaunchEnvironment, recordStartupError } from "./managed-launch-environment";

/** Prepare the managed profile without replacing the process opened by the user. */
export function handOffManagedWindowsLaunch(): void {
  if (process.platform !== "win32" || !app.isPackaged) return;
  app.setAppUserModelId("com.pi-gui.desktop");
  if (process.env.PI_GUI_INTEGRATED_LAUNCH === "1") return;
  const installRoot = path.dirname(process.execPath);
  const ecosystemRoot = path.join(path.dirname(installRoot), "pi-ecosystem");
  const launcher = path.join(ecosystemRoot, "scripts", "Launch-PiGui.ps1");
  if (!existsSync(launcher)) return;
  try {
    if (
      lstatSync(installRoot).isSymbolicLink() ||
      lstatSync(ecosystemRoot).isSymbolicLink() ||
      lstatSync(launcher).isSymbolicLink()
    ) {
      throw new Error("Unexpected managed launch path.");
    }
    const powershell = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const output = execFileSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        launcher,
        "-PrepareOnly",
        "-GuiProcessId",
        String(process.pid),
      ],
      {
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 256 * 1024,
        timeout: 30_000,
      },
    );
    applyManagedLaunchEnvironment(output, {
      userDataDir: path.join(ecosystemRoot, ".state", "pi-gui"),
      agentDir: path.join(ecosystemRoot, ".state", "agent"),
    });
  } catch (error) {
    recordStartupError(ecosystemRoot, error);
    dialog.showErrorBox(
      "Pegasus could not start",
      "The managed Pi profile could not be prepared. Review the private startup log in pi-ecosystem/.state.",
    );
    app.exit(1);
  }
}
