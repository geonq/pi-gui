import { useCallback, useState } from "react";

// Renderer-local view state: chats whose subagent rows are folded shut in the sidebar.
const STORAGE_KEY = "pi-gui:folded-chat-parents:v1";
const LIMIT = 200;

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

export function useFoldedChatParents() {
  const [folded, setFolded] = useState(loadFoldedChatParents);
  const setParentFolded = useCallback((parentKey: string, fold: boolean) => {
    setFolded((current) => {
      if (current.has(parentKey) === fold) return current;
      const next = new Set(current);
      if (fold) next.add(parentKey);
      else next.delete(parentKey);
      saveFoldedChatParents(next);
      return next;
    });
  }, []);
  return [folded, setParentFolded] as const;
}
