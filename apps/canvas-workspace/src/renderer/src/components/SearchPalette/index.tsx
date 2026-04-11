import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./index.css";
import type { CanvasNode, FileNodeData } from "../../types";

interface SearchResult {
  node: CanvasNode;
  matchType: "title-prefix" | "title-contains" | "filename" | "content";
  matchText: string;
}

interface Props {
  nodes: CanvasNode[];
  onSelect: (node: CanvasNode) => void;
  onClose: () => void;
}

type FilterType = "all" | "file" | "terminal";

const MAX_RESULTS = 25;

export const SearchPalette = ({ nodes, onSelect, onClose }: Props) => {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const searchResults = useMemo((): SearchResult[] => {
    if (!query.trim()) {
      const filtered = nodes.filter((node) => {
        if (filter === "all") return true;
        return node.type === filter;
      });
      return filtered.slice(0, MAX_RESULTS).map((node) => ({
        node,
        matchType: "title-contains" as const,
        matchText: node.title,
      }));
    }

    const q = query.toLowerCase();
    const results: SearchResult[] = [];

    for (const node of nodes) {
      if (filter !== "all" && node.type !== filter) continue;

      const titleLower = node.title.toLowerCase();
      const titleMatch: SearchResult | null = null;

      if (titleLower.startsWith(q)) {
        results.push({ node, matchType: "title-prefix", matchText: node.title });
        continue;
      }

      if (titleLower.includes(q)) {
        results.push({ node, matchType: "title-contains", matchText: node.title });
        continue;
      }

      if (node.type === "file") {
        const fileData = node.data as FileNodeData;
        const filePath = fileData.filePath || "";
        const fileName = filePath.split("/").pop() || "";
        const fileNameLower = fileName.toLowerCase();
        const filePathLower = filePath.toLowerCase();

        if (fileNameLower.includes(q) || filePathLower.includes(q)) {
          results.push({ node, matchType: "filename", matchText: filePath });
          continue;
        }

        const content = fileData.content || "";
        if (content.toLowerCase().includes(q)) {
          const idx = content.toLowerCase().indexOf(q);
          const start = Math.max(0, idx - 20);
          const end = Math.min(content.length, idx + q.length + 20);
          const snippet = (start > 0 ? "..." : "") + content.slice(start, end) + (end < content.length ? "..." : "");
          results.push({ node, matchType: "content", matchText: snippet });
          continue;
        }
      }
    }

    const priority: Record<SearchResult["matchType"], number> = {
      "title-prefix": 0,
      "title-contains": 1,
      filename: 2,
      content: 3,
    };

    results.sort((a, b) => {
      const pa = priority[a.matchType];
      const pb = priority[b.matchType];
      if (pa !== pb) return pa - pb;
      return a.node.title.localeCompare(b.node.title);
    });

    return results.slice(0, MAX_RESULTS);
  }, [query, nodes, filter]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, filter]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, searchResults.length - 1));
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }

      if (e.key === "Enter" && searchResults[selectedIndex]) {
        onSelect(searchResults[selectedIndex].node);
        onClose();
        return;
      }
    },
    [searchResults, selectedIndex, onSelect, onClose]
  );

  const handleResultClick = useCallback(
    (result: SearchResult) => {
      onSelect(result.node);
      onClose();
    },
    [onSelect, onClose]
  );

  return (
    <div className="search-palette-overlay" onClick={onClose}>
      <div className="search-palette" onClick={(e) => e.stopPropagation()}>
        <div className="search-input-wrapper">
          <svg className="search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            placeholder="Search nodes..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        <div className="search-filters">
          {(["all", "file", "terminal"] as const).map((type) => (
            <button
              key={type}
              className={`search-filter-btn ${filter === type ? "active" : ""}`}
              onClick={() => setFilter(type)}
            >
              {type === "all" ? "All" : type.charAt(0).toUpperCase() + type.slice(1)}
            </button>
          ))}
        </div>

        <div className="search-results">
          {searchResults.length === 0 ? (
            <div className="search-empty">No results found</div>
          ) : (
            searchResults.map((result, idx) => (
              <div
                key={result.node.id}
                className={`search-result ${idx === selectedIndex ? "selected" : ""}`}
                onClick={() => handleResultClick(result)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <div className="search-result-header">
                  <span className={`search-result-badge search-result-badge--${result.node.type}`}>
                    {result.node.type}
                  </span>
                  <span className="search-result-title">{result.node.title}</span>
                </div>
                {result.matchType !== "title-prefix" && result.matchType !== "title-contains" && (
                  <div className="search-result-match">{result.matchText}</div>
                )}
              </div>
            ))
          )}
        </div>

        <div className="search-hint">
          <span>↑↓ Navigate</span>
          <span>↵ Select</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  );
};
