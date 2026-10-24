import { app, ipcMain } from "electron";
import { desktopIpc } from "../../contracts/ipc";
import type { WindowOwner } from "../windows/window-owner";
import type { AppUpdater } from "./update-installer";

/**
 * Update and version IPC. Registered in host and Mac client mode alike: each app updates itself,
 * and every window hears status changes (progress, errors) for the banner.
 */
export function registerUpdateIpc(windows: WindowOwner, updater: AppUpdater): () => void {
  ipcMain.handle(desktopIpc.getAppVersion, (event) => {
    windows.windowForSender(event.sender);
    return app.getVersion();
  });
  ipcMain.handle(desktopIpc.getUpdateStatus, (event) => {
    windows.windowForSender(event.sender);
    return updater.getStatus();
  });
  ipcMain.handle(desktopIpc.checkForAppUpdate, (event) => {
    windows.windowForSender(event.sender);
    return updater.check();
  });
  ipcMain.handle(desktopIpc.installAppUpdate, (event) => {
    windows.windowForSender(event.sender);
    return updater.install();
  });
  return updater.subscribe((status) => {
    for (const window of windows.allWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(desktopIpc.updateStatusChanged, status);
      }
    }
  });
}
