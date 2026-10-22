import type { TranscriptMessage } from "./timeline-types";

export type AgentActivityState = "solving" | "listening" | "searching" | "connecting" | "composing";

export function activityForTool(toolName: string): { state: AgentActivityState; label: string } {
  if (
    /(?:web|browser|browse|internet|fetch_url|search_query|tavily|brave_search|exa_search)/i.test(
      toolName,
    )
  )
    return { state: "searching", label: "Searching…" };
  if (/(?:ask_user|question|confirm|approval|listen)/i.test(toolName))
    return { state: "listening", label: "Waiting for you…" };
  return { state: "connecting", label: "Working…" };
}

export function activityForTranscript(items: readonly TranscriptMessage[]): AgentActivityState {
  let reported: AgentActivityState | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    if (item.kind === "activity" && item.tone === "working") reported ??= item.activityState;
    if (item.kind === "message" && item.role === "user") break;
    if (item.kind === "tool" && item.status === "running")
      return activityForTool(item.toolName).state;
  }
  if (reported) return reported;
  const last = items.at(-1);
  return last?.kind === "message" && last.role === "assistant" && last.text
    ? "composing"
    : "solving";
}
