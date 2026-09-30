import { useEffect, useRef } from "react";

import { isMacHost } from "../../core/platform-info";
import { msg } from "../../i18n";

interface SearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

export function SearchBar({
  query,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
}: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="terminal-search-bar" role="search">
      <input
        ref={inputRef}
        className="terminal-search-bar__input"
        type="search"
        value={query}
        placeholder={msg.terminal.search.placeholder}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          // ⌘G / ⇧⌘G too on macOS, as in VS Code's terminal find.
          const findAgain =
            isMacHost() &&
            event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            event.code === "KeyG";
          if (event.key === "Enter" || findAgain) {
            event.preventDefault();
            if (event.shiftKey) {
              onPrevious();
            } else {
              onNext();
            }
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <button
        type="button"
        className="terminal-search-bar__button"
        title={msg.terminal.search.previous}
        onClick={onPrevious}
      >
        ↑
      </button>
      <button
        type="button"
        className="terminal-search-bar__button"
        title={msg.terminal.search.next}
        onClick={onNext}
      >
        ↓
      </button>
      <button
        type="button"
        className="terminal-search-bar__button"
        title={msg.terminal.search.close}
        onClick={onClose}
      >
        ✕
      </button>
    </div>
  );
}
