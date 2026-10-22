import type { WorkspaceRecord } from "../../../contracts/desktop-state";
import { formatRelativeTime } from "../../lib/string-utils";
import { FolderIcon, PlusIcon } from "../../ui/icons";
import "./project-overview.styles.css";

interface ProjectOverviewProps {
  readonly workspace: WorkspaceRecord;
  readonly onNewChat: () => void;
  readonly onBrowseFiles: () => void;
  readonly onOpenChat: (target: { workspaceId: string; sessionId: string }) => void;
}

export function ProjectOverview({
  workspace,
  onNewChat,
  onBrowseFiles,
  onOpenChat,
}: ProjectOverviewProps) {
  const recentSessions = [...workspace.sessions]
    .filter((session) => !session.archivedAt)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 3);

  return (
    <section
      aria-labelledby="project-overview-title"
      className="canvas canvas--empty project-overview-canvas"
    >
      <div className="project-overview">
        <header className="project-overview__header">
          <div className="project-overview__eyebrow">
            <span className="project-overview__eyebrow-icon">
              <FolderIcon />
            </span>
            Project
          </div>

          <h1 className="project-overview__title" id="project-overview-title">
            {workspace.name}
          </h1>

          {window.piApp?.backend === "windows" ? (
            <span
              className="project-overview__backend"
              title="Chat history and model requests are handled by your Windows server."
            >
              Windows backend
            </span>
          ) : null}
          <div className="project-overview__metadata">
            <div className="project-overview__location" title={workspace.path}>
              <span>Folder</span>
              <code>{workspace.path}</code>
            </div>
            {workspace.branchName ? (
              <span className="project-overview__branch">{workspace.branchName}</span>
            ) : null}
          </div>
        </header>

        <div className="project-overview__body">
          <div className="project-overview__actions">
            <button className="button button--primary" onClick={onNewChat} type="button">
              <span className="project-overview__action-icon">
                <PlusIcon />
              </span>
              New chat
            </button>
            <button className="button button--ghost" onClick={onBrowseFiles} type="button">
              <span className="project-overview__action-icon">
                <FolderIcon />
              </span>
              Browse files
            </button>
          </div>

          <section
            aria-labelledby="project-overview-recent-title"
            className="project-overview__recent"
          >
            <h2 id="project-overview-recent-title">Recent chats</h2>
            {recentSessions.length > 0 ? (
              <div className="project-overview__recent-list">
                {recentSessions.map((session) => (
                  <button
                    className="project-overview__recent-chat"
                    key={session.id}
                    onClick={() => onOpenChat({ workspaceId: workspace.id, sessionId: session.id })}
                    type="button"
                  >
                    <span>{session.title || "Untitled chat"}</span>
                    <time dateTime={session.updatedAt}>
                      {formatRelativeTime(session.updatedAt)}
                    </time>
                  </button>
                ))}
              </div>
            ) : (
              <p>No active chats in this project yet.</p>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
