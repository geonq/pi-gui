import { ThinkingOrb } from "thinking-orbs";
import type { DesktopAppState } from "../../../contracts/desktop-state";
import { useSystemMotionPaused } from "../../app/activity-indicator";
import { useActiveTheme } from "../../ui/active-theme";

interface SessionTarget {
  readonly workspaceId: string;
  readonly sessionId: string;
}

interface AgentRow {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly status: string;
  readonly target: SessionTarget;
}

const STATUS_LABEL: Record<string, string> = {
  running: "Working",
  queued: "Queued",
  waiting: "Waiting",
  failed: "Failed",
  complete: "Done",
};
const RANK: Record<string, number> = { running: 0, waiting: 1, queued: 2, failed: 3, complete: 4 };
const ACTIVE = new Set(["running", "waiting", "queued"]);
const keyOf = (target: SessionTarget) => `${target.workspaceId}/${target.sessionId}`;

/** Every parallel agent and every working or failed thread, across workspaces, working ones first. */
export function AgentsPanel({
  snapshot,
  onSelect,
}: {
  readonly snapshot: DesktopAppState;
  readonly onSelect: (target: SessionTarget) => void;
}) {
  const { variant } = useActiveTheme();
  const paused = useSystemMotionPaused();
  const titles = new Map(
    snapshot.workspaces.flatMap((workspace) =>
      workspace.sessions.map((session) => [`${workspace.id}/${session.id}`, session.title]),
    ),
  );
  const agents: AgentRow[] = snapshot.orchestrationChildren.map((child) => ({
    key: child.id,
    title: child.title,
    detail: `Agent of ${titles.get(`${child.parentWorkspaceId}/${child.parentSessionId}`) ?? "a thread"}`,
    status: child.status,
    target: { workspaceId: child.childWorkspaceId, sessionId: child.childSessionId },
  }));
  const agentKeys = new Set(agents.map((agent) => keyOf(agent.target)));
  const threads: AgentRow[] = snapshot.workspaces.flatMap((workspace) =>
    workspace.sessions
      .filter((session) => session.status !== "idle" && !session.archivedAt)
      .map((session) => ({
        key: `${workspace.id}/${session.id}`,
        title: session.title,
        detail: workspace.name,
        status: session.status,
        target: { workspaceId: workspace.id, sessionId: session.id },
      }))
      .filter((row) => !agentKeys.has(row.key)),
  );
  const rows = [...agents, ...threads].sort(
    (a, b) => (RANK[a.status] ?? 5) - (RANK[b.status] ?? 5),
  );
  const working = rows.filter((row) => ACTIVE.has(row.status)).length;

  return (
    <div className="agents-panel">
      <p className="agents-panel__summary" aria-live="polite">
        {working ? `${working} working` : "Nothing is working"}
        {rows.length ? ` · ${rows.length} total` : ""}
      </p>
      <ul className="agents-panel__list">
        {rows.map((row) => (
          <li key={row.key}>
            <button
              className="agents-panel__row"
              type="button"
              onClick={() => onSelect(row.target)}
            >
              {ACTIVE.has(row.status) ? (
                <ThinkingOrb
                  aria-hidden="true"
                  paused={paused}
                  size={20}
                  state="working"
                  theme={variant}
                />
              ) : (
                <span
                  aria-hidden="true"
                  className={`agents-panel__dot agents-panel__dot--${row.status}`}
                />
              )}
              <span className="agents-panel__text">
                <span className="agents-panel__title" title={row.title}>
                  {row.title}
                </span>
                <span className="agents-panel__detail">{row.detail}</span>
              </span>
              <span className="agents-panel__status">{STATUS_LABEL[row.status] ?? row.status}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
