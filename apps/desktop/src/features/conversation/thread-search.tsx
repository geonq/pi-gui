import type { RefObject } from "react";
import { ChevronDownIcon, CloseIcon } from "../../ui/icons";

interface ThreadSearchBarProps {
  readonly query: string;
  readonly matchCount: number;
  readonly activeIndex: number;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onSearch: (query: string) => void;
  readonly onNext: () => void;
  readonly onPrev: () => void;
  readonly onClose: () => void;
}

export function ThreadSearchBar({
  query,
  matchCount,
  activeIndex,
  inputRef,
  onSearch,
  onNext,
  onPrev,
  onClose,
}: ThreadSearchBarProps) {
  return (
    <div className="thread-search-bar" data-testid="thread-search-bar">
      <input
        ref={inputRef}
        className="thread-search-bar__input"
        type="text"
        autoComplete="off"
        placeholder="Search thread…"
        spellCheck={false}
        value={query}
        onChange={(e) => onSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) {
              onPrev();
            } else {
              onNext();
            }
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span aria-live="polite" className="thread-search-bar__count">
        {query ? (matchCount > 0 ? `${activeIndex + 1} / ${matchCount}` : "0 results") : ""}
      </span>
      <div className="thread-search-bar__actions">
        <button
          aria-label="Previous match"
          className="icon-button"
          type="button"
          disabled={matchCount === 0}
          onClick={onPrev}
        >
          <span className="icon-flip">
            <ChevronDownIcon />
          </span>
        </button>
        <button
          aria-label="Next match"
          className="icon-button"
          type="button"
          disabled={matchCount === 0}
          onClick={onNext}
        >
          <ChevronDownIcon />
        </button>
        <button aria-label="Close search" className="icon-button" type="button" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
