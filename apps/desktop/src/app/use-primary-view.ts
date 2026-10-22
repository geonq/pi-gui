import { useEffect, useRef } from "react";
import type { AppView } from "../../contracts/desktop-state";

/** The last non-secondary view, so "Back to app" from Settings, Skills or Extensions returns to it. */
export function usePrimaryView(activeView: AppView | undefined): () => AppView {
  const primaryView = useRef<AppView>("threads");
  useEffect(() => {
    if (
      activeView &&
      activeView !== "settings" &&
      activeView !== "skills" &&
      activeView !== "extensions"
    ) {
      primaryView.current = activeView;
    }
  }, [activeView]);
  return () => primaryView.current;
}
