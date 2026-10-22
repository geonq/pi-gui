import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  isThemeMode,
  isThemePresetId,
  type ThemeMode,
  type ThemePresetId,
} from "../../contracts/desktop-state";
import { writeFileAtomicQueued } from "../persistence/atomic-file-write";
import { readPersistedUiState } from "../persistence/app-store-persistence";

export interface RemoteDesktopClientPreferences {
  readonly enableTransparency: boolean;
  readonly themeMode: ThemeMode;
  readonly themePresetId: ThemePresetId;
}

export type RemoteDesktopClientPreferencesPatch = Partial<RemoteDesktopClientPreferences>;

export const DEFAULT_REMOTE_DESKTOP_CLIENT_PREFERENCES: RemoteDesktopClientPreferences = {
  enableTransparency: true,
  themeMode: "system",
  themePresetId: "default",
};

const PREFERENCES_FILE = "remote-desktop-ui.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodePreferences(value: unknown): RemoteDesktopClientPreferences {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        key !== "version" &&
        key !== "enableTransparency" &&
        key !== "themeMode" &&
        key !== "themePresetId",
    ) ||
    value.version !== 1 ||
    typeof value.enableTransparency !== "boolean" ||
    !isThemeMode(value.themeMode) ||
    !isThemePresetId(value.themePresetId)
  ) {
    throw new Error("Remote desktop local preferences are invalid.");
  }
  return {
    enableTransparency: value.enableTransparency,
    themeMode: value.themeMode,
    themePresetId: value.themePresetId,
  };
}

export function validateRemoteDesktopClientPreferencesPatch(
  value: unknown,
): RemoteDesktopClientPreferencesPatch {
  if (
    !isRecord(value) ||
    Object.keys(value).length === 0 ||
    Object.keys(value).some(
      (key) => key !== "enableTransparency" && key !== "themeMode" && key !== "themePresetId",
    ) ||
    ("enableTransparency" in value && typeof value.enableTransparency !== "boolean") ||
    ("themeMode" in value && !isThemeMode(value.themeMode)) ||
    ("themePresetId" in value && !isThemePresetId(value.themePresetId))
  ) {
    throw new TypeError("Remote desktop local preference update is invalid.");
  }
  return value as RemoteDesktopClientPreferencesPatch;
}

export async function loadRemoteDesktopClientPreferences(
  userDataDir: string,
): Promise<RemoteDesktopClientPreferences> {
  const filePath = path.join(userDataDir, PREFERENCES_FILE);
  try {
    const raw = await readFile(filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 4_096)
      throw new Error("Local preferences exceed their size limit.");
    return decodePreferences(JSON.parse(raw) as unknown);
  } catch (error) {
    if (isMissingFile(error)) {
      try {
        const persisted = await readPersistedUiState(path.join(userDataDir, "ui-state.json"));
        return {
          enableTransparency:
            persisted.enableTransparency ??
            DEFAULT_REMOTE_DESKTOP_CLIENT_PREFERENCES.enableTransparency,
          themeMode: persisted.themeMode ?? DEFAULT_REMOTE_DESKTOP_CLIENT_PREFERENCES.themeMode,
          themePresetId:
            persisted.themePresetId ?? DEFAULT_REMOTE_DESKTOP_CLIENT_PREFERENCES.themePresetId,
        };
      } catch {
        return DEFAULT_REMOTE_DESKTOP_CLIENT_PREFERENCES;
      }
    }
    return DEFAULT_REMOTE_DESKTOP_CLIENT_PREFERENCES;
  }
}

export async function persistRemoteDesktopClientPreferences(
  userDataDir: string,
  preferences: RemoteDesktopClientPreferences,
): Promise<void> {
  const filePath = path.join(userDataDir, PREFERENCES_FILE);
  const payload = { version: 1, ...preferences };
  await writeFileAtomicQueued(filePath, `${JSON.stringify(payload, null, 2)}\n`, decodePreferences);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
