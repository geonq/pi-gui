import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import type { SessionExtensionUiStateRecord } from "../../../contracts/desktop-state";
import {
  isSessionMode,
  sessionModeStatusKey,
  type SessionMode,
} from "../../../contracts/session-mode";
import { ForkIcon, PencilIcon, SearchIcon, SparkIcon } from "../../ui/icons";

const MODE_OPTIONS: readonly {
  readonly value: SessionMode;
  readonly label: string;
  readonly description: string;
  readonly icon: ReactNode;
}[] = [
  { value: "planner", label: "Plan", description: "Read-only, plans first", icon: <SparkIcon /> },
  { value: "reviewer", label: "Review", description: "Read-only review", icon: <SearchIcon /> },
  {
    value: "implementer",
    label: "Full access",
    description: "Edits files, runs commands",
    icon: <PencilIcon />,
  },
  {
    value: "orchestrator",
    label: "Delegate",
    description: "Runs subagent chats, no edits",
    icon: <ForkIcon />,
  },
];

/**
 * The mode the Pi extension reports for this chat: a mode, `null` when the chat supports modes but
 * none is active yet, or `undefined` when the chat has no modes (no Pi workflow for its folder).
 */
export function sessionModeFromUi(
  uiState?: SessionExtensionUiStateRecord,
): SessionMode | null | undefined {
  const status = uiState?.statuses.find((entry) => entry.key === sessionModeStatusKey);
  if (!status) return undefined;
  const text = status.text.trim();
  return isSessionMode(text) ? text : null;
}

/**
 * A chat reports its mode once its Pi session has started (first message or first pick). Until
 * then the picker still shows, as "Mode", when the folder's extensions provide `/mode`.
 */
export function runtimeHasModes(runtime: RuntimeSnapshot | undefined): boolean {
  return Boolean(
    runtime?.extensions.some(
      (extension) => extension.enabled && extension.commands.includes("mode"),
    ),
  );
}

/** Switches a chat's mode; the new mode arrives with the next app state from main. */
export function sessionModeSetter(
  workspaceId: string | undefined,
  sessionId: string | undefined,
): (mode: SessionMode) => void {
  return (mode) => {
    if (!workspaceId || !sessionId) return;
    window.piApp?.setSessionMode(workspaceId, sessionId, mode).catch((error: unknown) => {
      console.error("[renderer] setSessionMode failed", error);
    });
  };
}

interface ModeSelectorProps {
  readonly mode: SessionMode | null;
  readonly disabled?: boolean;
  readonly onSetMode: (mode: SessionMode) => void;
}

export function ModeSelector({ mode, disabled, onSetMode }: ModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const active = MODE_OPTIONS.find((option) => option.value === mode);

  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <span className="model-selector" ref={containerRef}>
      <span className="model-selector__anchor">
        <button
          aria-expanded={open}
          aria-haspopup="true"
          aria-label={`Mode: ${active?.label ?? "not set"}`}
          className="model-selector__badge"
          type="button"
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
        >
          {active?.icon}
          <span>{active?.label ?? "Mode"}</span>
        </button>
        {open ? (
          <div className="model-selector__dropdown" onWheel={(event) => event.stopPropagation()}>
            <div className="model-selector__group-title">Mode</div>
            {MODE_OPTIONS.map((option) => {
              const isActive = option.value === mode;
              return (
                <button
                  aria-pressed={isActive}
                  className={`model-selector__item${isActive ? " model-selector__item--active" : ""}`}
                  key={option.value}
                  type="button"
                  onClick={() => {
                    if (!isActive) onSetMode(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="model-selector__item-label">{option.label}</span>
                  <span className="model-selector__item-meta">{option.description}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </span>
    </span>
  );
}
