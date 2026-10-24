import { useCallback, useEffect, useRef, useState } from "react";

// Renderer-local view state: chats whose subagent rows are folded shut in the sidebar.
const STORAGE_KEY = "pi-gui:folded-chat-parents:v1";
const LIMIT = 200;
/** Matches the `.session-row--leaving` transition; the rows unmount once it has played. */
const FOLD_CLOSE_MS = 170;
/** Long enough for the `.session-row--entering` transition to finish before the class drops. */
const FOLD_OPEN_MS = 260;

/** Subagent rows animating in (`opening`) or out (`closing`), keyed by their parent chat. */
export type ChatFoldMotion = ReadonlyMap<string, "opening" | "closing">;

export function loadFoldedChatParents(): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "[]");
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((key): key is string => typeof key === "string").slice(-LIMIT));
    }
  } catch {
    // unreadable or unavailable storage; start with every chat open
  }
  return new Set();
}

function saveFoldedChatParents(keys: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...keys].slice(-LIMIT)));
  } catch {
    // localStorage unavailable; skip persistence
  }
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function useFoldedChatParents() {
  const [folded, setFolded] = useState(loadFoldedChatParents);
  const [motion, setMotion] = useState<ChatFoldMotion>(() => new Map());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  const setRowsMotion = useCallback((parentKey: string, phase?: "opening" | "closing") => {
    setMotion((current) => {
      if (current.get(parentKey) === phase) return current;
      const next = new Map(current);
      if (phase) next.set(parentKey, phase);
      else next.delete(parentKey);
      return next;
    });
  }, []);

  const commitFolded = useCallback((parentKey: string, fold: boolean) => {
    setFolded((current) => {
      if (current.has(parentKey) === fold) return current;
      const next = new Set(current);
      if (fold) next.add(parentKey);
      else next.delete(parentKey);
      saveFoldedChatParents(next);
      return next;
    });
  }, []);

  const setParentFolded = useCallback(
    (parentKey: string, fold: boolean) => {
      clearTimeout(timers.current.get(parentKey));
      timers.current.delete(parentKey);
      if (prefersReducedMotion()) {
        setRowsMotion(parentKey, undefined);
        commitFolded(parentKey, fold);
        return;
      }
      // Opening mounts the rows straight away and they grow in; closing keeps them mounted while
      // they shrink away, then drops them from the list.
      if (!fold) commitFolded(parentKey, false);
      setRowsMotion(parentKey, fold ? "closing" : "opening");
      timers.current.set(
        parentKey,
        setTimeout(
          () => {
            timers.current.delete(parentKey);
            if (fold) commitFolded(parentKey, true);
            setRowsMotion(parentKey, undefined);
          },
          fold ? FOLD_CLOSE_MS : FOLD_OPEN_MS,
        ),
      );
    },
    [commitFolded, setRowsMotion],
  );

  return [folded, setParentFolded, motion] as const;
}
