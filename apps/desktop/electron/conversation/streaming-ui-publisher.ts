import { sessionKey } from "@pi-gui/session-driver";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";

/**
 * Trailing-edge interval for streaming transcript / sidebar publishes.
 * Hidden macOS CI windows coalesce Node timers past this delay, so Electron
 * proofs must poll for the flush instead of waiting interval+slack once.
 */
export const STREAMING_UI_PUBLISH_INTERVAL_MS = 50;

/**
 * While a reply streams, the transcript is published every interval above, but a tick changes
 * nothing else in app state except the sidebar preview and timestamps. A full DesktopAppState
 * snapshot (hundreds of KB: model catalogs, subagent records) on every tick kept main and the
 * renderer busy cloning it ~14 times a second, so streaming ticks publish app state at this pace.
 */
export const STREAMING_STATE_PUBLISH_INTERVAL_MS = 500;

/** Runs `publish` at most once per interval; a call inside the interval runs once at its end. */
export class TrailingThrottle {
  private last = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly publish: () => void,
    private readonly intervalMs: number = STREAMING_STATE_PUBLISH_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  request(): void {
    if (this.timer) return;
    const wait = this.last + this.intervalMs - this.now();
    if (wait <= 0) {
      this.run();
      return;
    }
    this.timer = setTimeout(() => this.run(), wait);
  }

  /** A full publish just happened elsewhere, so nothing is owed until the next interval. */
  published(): void {
    this.cancel();
    this.last = this.now();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private run(): void {
    this.timer = undefined;
    this.last = this.now();
    this.publish();
  }
}

/**
 * Token-level `assistantDelta` always arrives with a redundant `sessionUpdated`
 * (preview/timestamp). Publishing full app state for each pair was the leftover
 * #93 CPU path after #114. Defer those two; flush immediately on discrete events.
 *
 * `trackedRunId` is the last observed `snapshot.runningRunId` for this session.
 * A new run id (Send after Stop) is not deferred. Do not pass
 * `runningSinceBySession.has` — user cancel never clears that map.
 */
export function shouldDeferStreamingUiPublish(
  event: SessionDriverEvent,
  trackedRunId: string | undefined,
): boolean {
  if (event.type === "assistantDelta" || event.type === "assistantThinkingDelta") {
    return true;
  }
  if (event.type !== "sessionUpdated" || event.snapshot.status !== "running") {
    return false;
  }
  const runId = event.snapshot.runningRunId;
  return Boolean(runId) && runId === trackedRunId;
}

/**
 * At most one UI publish per session per interval. Later tokens in the window
 * reuse the pending timer; a discrete event cancels it because it is about to
 * `emit()` itself. Also owns last-seen runningRunId so Stop→Send is immediate.
 */
export class StreamingUiPublisher {
  private readonly pending = new Map<
    string,
    { readonly sessionRef: SessionRef; readonly timer: ReturnType<typeof setTimeout> }
  >();
  private readonly trackedRunId = new Map<string, string>();

  constructor(
    private readonly publish: (sessionRef: SessionRef) => void,
    private readonly intervalMs: number = STREAMING_UI_PUBLISH_INTERVAL_MS,
  ) {}

  shouldDefer(event: SessionDriverEvent): boolean {
    return shouldDeferStreamingUiPublish(
      event,
      this.trackedRunId.get(sessionKey(event.sessionRef)),
    );
  }

  /**
   * Record the run id after the defer decision for this event so the first
   * running tick is not deferred by its own write.
   */
  observe(event: SessionDriverEvent): void {
    const key = sessionKey(event.sessionRef);
    if (event.type === "sessionClosed") {
      this.trackedRunId.delete(key);
      return;
    }
    if (
      event.type === "sessionUpdated" &&
      event.snapshot.status === "running" &&
      event.snapshot.runningRunId
    ) {
      this.trackedRunId.set(key, event.snapshot.runningRunId);
    }
  }

  schedule(sessionRef: SessionRef): void {
    const key = sessionKey(sessionRef);
    if (this.pending.has(key)) {
      return;
    }
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.publish(sessionRef);
    }, this.intervalMs);
    this.pending.set(key, { sessionRef, timer });
  }

  cancel(sessionRef: SessionRef): void {
    const key = sessionKey(sessionRef);
    const entry = this.pending.get(key);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(key);
  }

  clear(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
  }
}
