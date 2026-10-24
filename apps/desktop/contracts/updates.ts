/** What the app knows about its own update, shown as the update banner. */
export type UpdatePhase = "idle" | "available" | "downloading" | "installing" | "error";

export interface UpdateStatus {
  readonly phase: UpdatePhase;
  readonly currentVersion: string;
  readonly latestVersion?: string;
  readonly releaseUrl?: string;
  /** The Windows host's version, when this app is the Mac remote client. */
  readonly hostVersion?: string;
  /** This build can download and install the release itself (packaged, supported platform). */
  readonly canInstall?: boolean;
  /** Download progress from 0 to 1. */
  readonly progress?: number;
  readonly message?: string;
}

function versionParts(version: string): readonly number[] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Whether the Mac client's Windows host runs a newer or older release than the client. */
export function hostVersionDrift(status: UpdateStatus): "host-newer" | "host-older" | undefined {
  const host = status.hostVersion ? versionParts(status.hostVersion) : undefined;
  const own = versionParts(status.currentVersion);
  if (!host || !own) return undefined;
  for (let index = 0; index < 3; index += 1) {
    if (host[index]! !== own[index]!)
      return host[index]! > own[index]! ? "host-newer" : "host-older";
  }
  return undefined;
}
