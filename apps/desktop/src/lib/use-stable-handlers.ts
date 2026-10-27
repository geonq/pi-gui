import { useRef } from "react";

type Handler = (...args: unknown[]) => unknown;

/**
 * Keeps one object identity while its non-function fields are unchanged, so a memoized child
 * skips renders caused only by fresh closures. Each function field becomes a stable proxy that
 * calls the latest version, so nothing reads stale state.
 */
export function useStableHandlers<T extends object>(value: T): T {
  const latest = useRef(value);
  latest.current = value;
  const proxies = useRef(new Map<string, Handler>());
  const previous = useRef<T | null>(null);

  const before = previous.current;
  const keys = Object.keys(value);
  if (
    before &&
    keys.length === Object.keys(before).length &&
    keys.every((key) => {
      const next: unknown = Reflect.get(value, key);
      const prior: unknown = Reflect.get(before, key);
      return typeof next === "function" ? typeof prior === "function" : Object.is(next, prior);
    })
  ) {
    return before;
  }

  const stable = { ...value };
  for (const key of keys) {
    if (typeof Reflect.get(value, key) !== "function") continue;
    let proxy = proxies.current.get(key);
    if (!proxy) {
      proxy = (...args) => {
        const handler: unknown = Reflect.get(latest.current, key);
        return typeof handler === "function" ? Reflect.apply(handler, undefined, args) : undefined;
      };
      proxies.current.set(key, proxy);
    }
    Reflect.set(stable, key, proxy);
  }
  previous.current = stable;
  return stable;
}
