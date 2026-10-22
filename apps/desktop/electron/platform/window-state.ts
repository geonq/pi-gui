import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { screen, type BrowserWindow, type Rectangle } from "electron";

export interface SavedWindowState {
  /** Normal (not maximized) bounds, so un-maximizing returns to the size the owner chose. */
  readonly bounds: Rectangle;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
}

const FILE = "window-state.json";

/**
 * The size and place the window had when it was last closed. A position that no longer lands on a
 * connected display (monitor unplugged) keeps its size but drops x/y, so the OS centres it.
 */
export function loadWindowState(userDataDir: string): SavedWindowState | undefined {
  try {
    const saved = JSON.parse(readFileSync(path.join(userDataDir, FILE), "utf8")) as SavedWindowState;
    const { x, y, width, height } = saved.bounds;
    if (![x, y, width, height].every(Number.isFinite) || width < 400 || height < 300) return undefined;
    const area = screen.getDisplayMatching(saved.bounds).workArea;
    const onScreen =
      x < area.x + area.width - 80 && x + width > area.x + 80 && y >= area.y - 40 && y < area.y + area.height - 80;
    return onScreen ? saved : { ...saved, bounds: { width, height } as Rectangle };
  } catch {
    return undefined;
  }
}

/** Saves the window's state shortly after it moves or resizes, and once more when it closes. */
export function trackWindowState(window: BrowserWindow, userDataDir: string): void {
  let timer: NodeJS.Timeout | undefined;
  const save = () => {
    if (window.isDestroyed()) return;
    const state: SavedWindowState = {
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
    };
    try {
      mkdirSync(userDataDir, { recursive: true });
      writeFileSync(path.join(userDataDir, FILE), JSON.stringify(state));
    } catch {
      // A read-only profile only loses the remembered size.
    }
  };
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  };
  window.on("resize", soon);
  window.on("move", soon);
  window.on("maximize", soon);
  window.on("unmaximize", soon);
  window.on("enter-full-screen", soon);
  window.on("leave-full-screen", soon);
  window.on("close", () => {
    clearTimeout(timer);
    save();
  });
}
