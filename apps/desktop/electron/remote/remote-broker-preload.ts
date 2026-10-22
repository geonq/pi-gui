import "../preload";
import { contextBridge, ipcRenderer } from "electron";
import {
  isRemoteBrokerResponse,
  isRemoteDesktopEvent,
  isRemoteDesktopPiMethod,
  remoteBrokerIpc,
  type RemoteBrokerRendererBridge,
  type RemoteBrokerRequest,
} from "./remote-desktop-protocol";

const requestListeners = new Set<(request: RemoteBrokerRequest) => void>();

ipcRenderer.on(remoteBrokerIpc.request, (_event, value: unknown) => {
  if (!isRequest(value)) return;
  for (const listener of requestListeners) listener(value);
});

const brokerBridge: RemoteBrokerRendererBridge = {
  onRequest(listener) {
    requestListeners.add(listener);
    return () => requestListeners.delete(listener);
  },
  respond(response) {
    if (isRemoteBrokerResponse(response)) ipcRenderer.send(remoteBrokerIpc.response, response);
  },
  publish(event) {
    if (isRemoteDesktopEvent(event)) ipcRenderer.send(remoteBrokerIpc.event, event);
  },
  ready() {
    ipcRenderer.send(remoteBrokerIpc.ready, { ready: true });
  },
};

contextBridge.exposeInMainWorld("__piRemoteBroker", brokerBridge);

function isRequest(value: unknown): value is RemoteBrokerRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).requestId === "string" &&
    isRemoteDesktopPiMethod((value as Record<string, unknown>).method) &&
    Array.isArray((value as Record<string, unknown>).args)
  );
}
