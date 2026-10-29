import { Menu, Tray, type NativeImage } from "electron";

/**
 * Pegasus's Windows tray icon. Closing the last window leaves Pegasus running here (the Mac's remote
 * session and scheduled work keep going); the menu reopens the window or quits for real.
 */
export function installAppTray({
  icon,
  onOpen,
  onQuit,
}: {
  readonly icon: NativeImage;
  readonly onOpen: () => void;
  readonly onQuit: () => void;
}): Tray {
  const tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Pegasus");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Pegasus", click: onOpen },
      { type: "separator" },
      { label: "Quit Pegasus", click: onQuit },
    ]),
  );
  tray.on("click", onOpen);
  return tray;
}
