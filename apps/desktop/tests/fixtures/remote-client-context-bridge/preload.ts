import { contextBridge } from "electron";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { createRemoteDesktopClientApi } from "../../../electron/remote/remote-desktop-client-preload";
import type { RemoteDesktopClientPreferences } from "../../../electron/remote/remote-desktop-client-preferences";

let preferences: RemoteDesktopClientPreferences = {
  enableTransparency: false,
  themeMode: "light",
  themePresetId: "default",
};
const localApi = {
  platform: process.platform,
  versions: process.versions,
  ping: async () => "pong",
  getState: async () => ({}),
} as unknown as PiDesktopApi;
const api = createRemoteDesktopClientApi(
  localApi,
  async (method) => {
    if (method === "getState") {
      return { themeMode: "dark", enableTransparency: true, composerDraft: "host draft" };
    }
    return undefined;
  },
  () => () => undefined,
  async () => preferences,
  async (patch) => {
    preferences = { ...preferences, ...patch };
    return preferences;
  },
);

contextBridge.exposeInMainWorld("piApp", api);
