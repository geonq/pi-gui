import { useEffect, useState, type ReactNode } from "react";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { hostVersionDrift, type UpdateStatus } from "../../../contracts/updates";
import "./update-banner.css";

const DISMISSED_KEY = "pegasus.updateDismissed.v1";

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/**
 * The sidebar's update notice: a new release with Update (download, verify, install, restart),
 * progress while that runs, and on the Mac a note when Windows runs a different version.
 */
export function UpdateBanner({ api }: { readonly api: PiDesktopApi | undefined }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    if (!api?.getUpdateStatus) return undefined;
    let live = true;
    api
      .getUpdateStatus()
      .then((next) => {
        if (live) setStatus(next);
      })
      .catch(() => undefined);
    const stop = api.onUpdateStatus?.((next) => setStatus(next));
    return () => {
      live = false;
      stop?.();
    };
  }, [api]);

  if (!status || !api) return null;
  const drift = hostVersionDrift(status);
  const latest = status.latestVersion;

  const install = () => {
    setRequested(true);
    void api
      .installAppUpdate()
      .catch(() => undefined)
      .finally(() => setRequested(false));
  };
  const later = () => {
    if (!latest) return;
    setDismissed(latest);
    try {
      localStorage.setItem(DISMISSED_KEY, latest);
    } catch {
      // Without storage the notice simply returns next launch.
    }
  };

  let text: string;
  let actions: ReactNode = null;
  if (status.phase === "downloading") {
    text = `Downloading Pegasus ${latest} · ${Math.round((status.progress ?? 0) * 100)}%`;
  } else if (status.phase === "installing") {
    text = `Installing Pegasus ${latest}. It restarts in a moment.`;
  } else if (status.phase === "error") {
    text = status.message ?? "The update could not be installed.";
    actions = (
      <button className="update-banner__action" type="button" onClick={install}>
        Try again
      </button>
    );
  } else if (status.phase === "available" && latest && (latest !== dismissed || drift)) {
    text =
      drift === "host-newer"
        ? `Pegasus ${latest} is available. Windows already runs ${status.hostVersion}.`
        : `Pegasus ${latest} is available. You have ${status.currentVersion}.`;
    actions = (
      <>
        {status.canInstall ? (
          <button
            className="update-banner__action"
            disabled={requested}
            type="button"
            onClick={install}
          >
            Update
          </button>
        ) : status.releaseUrl ? (
          <button
            className="update-banner__action"
            type="button"
            onClick={() => void api.openExternal(status.releaseUrl!).catch(() => undefined)}
          >
            Download
          </button>
        ) : null}
        {drift ? null : (
          <button className="update-banner__later" type="button" onClick={later}>
            Later
          </button>
        )}
      </>
    );
  } else if (drift === "host-newer") {
    text = `Windows runs Pegasus ${status.hostVersion}; this Mac runs ${status.currentVersion}. The Mac build is not published yet.`;
  } else if (drift === "host-older") {
    text = `Windows still runs Pegasus ${status.hostVersion}. Update it there to match this Mac (${status.currentVersion}).`;
  } else {
    return null;
  }

  return (
    <div
      aria-live="polite"
      className={`update-banner${status.phase === "error" ? " update-banner--error" : ""}`}
      data-testid="update-banner"
      role="status"
    >
      <span className="update-banner__text">{text}</span>
      {status.phase === "downloading" ? (
        <span className="update-banner__progress" aria-hidden="true">
          <span style={{ width: `${Math.round((status.progress ?? 0) * 100)}%` }} />
        </span>
      ) : null}
      {actions ? <span className="update-banner__actions">{actions}</span> : null}
    </div>
  );
}
