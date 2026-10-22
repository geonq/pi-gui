import { useEffect, useState } from "react";
import { BorderBeam } from "border-beam";
import { ThinkingOrb } from "thinking-orbs";
import { AnimatePresence, motion } from "motion/react";
import type { AgentActivityState } from "../../contracts/agent-activity";
import { useActiveTheme } from "../ui/active-theme";

interface ActivityIndicatorProps {
  readonly label: string;
  readonly state?: AgentActivityState;
}

/** Activity motion stops for reduced-motion users and while the window is hidden. */
export function useSystemMotionPaused(): boolean {
  const [paused, setPaused] = useState(true);
  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPaused(reducedMotion.matches || document.hidden);
    update();
    reducedMotion.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      reducedMotion.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return paused;
}

/** Fixed canvas bounds and a short crossfade keep state changes from flashing or shifting text. */
export function StateOrb({
  state,
  size = 20,
  paused: requestedPause = false,
}: {
  readonly state: AgentActivityState;
  readonly size?: 20 | 64;
  readonly paused?: boolean;
}) {
  const { variant } = useActiveTheme();
  const paused = useSystemMotionPaused() || requestedPause;
  return (
    <span
      className="state-orb"
      data-orb-state={state}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <AnimatePresence initial={false}>
        <motion.span
          key={state}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: paused ? 0 : 0.2 }}
        >
          <ThinkingOrb paused={paused} size={size} state={state} theme={variant} />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export function ActivityIndicator({ label, state = "solving" }: ActivityIndicatorProps) {
  const { variant } = useActiveTheme();
  const systemPaused = useSystemMotionPaused();
  const [manuallyPaused, setManuallyPaused] = useState(false);
  const [longRunning, setLongRunning] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setLongRunning(true), 5000);
    return () => window.clearTimeout(timer);
  }, []);

  const paused = systemPaused || manuallyPaused;

  return (
    <div className="running-activity">
      <BorderBeam
        active={!paused}
        brightness={0.8}
        className="running-activity__beam"
        colorVariant="mono"
        duration={3.2}
        glowSize={0.55}
        saturation={0.75}
        size="sm"
        staticColors
        strength={0.5}
        theme={variant}
      >
        <span className="running-activity__badge">
          <StateOrb paused={paused} state={state} />
          <span aria-hidden="true">{label}</span>
          <span className="sr-only" role="status">
            Agent working
          </span>
        </span>
      </BorderBeam>
      {longRunning && !systemPaused ? (
        <button
          aria-label={manuallyPaused ? "Resume activity animation" : "Pause activity animation"}
          aria-pressed={manuallyPaused}
          className="running-activity__toggle"
          onClick={() => setManuallyPaused((current) => !current)}
          title={manuallyPaused ? "Resume activity animation" : "Pause activity animation"}
          type="button"
        >
          {manuallyPaused ? "Resume" : "Pause"}
        </button>
      ) : null}
    </div>
  );
}
