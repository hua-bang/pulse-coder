import { useCallback, useEffect, useRef, useState } from "react";
import "./index.css";
import type { CanvasNode, IframeNodeData } from "../../types";

interface Props {
  node: CanvasNode;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}

/**
 * Renders an external web page in an <iframe>.
 *
 * - Empty URL → show a URL input as the placeholder state.
 * - Loaded URL → show a compact address bar + iframe. The address bar can be
 *   toggled into edit mode to change the URL, opened externally, or reloaded.
 *
 * Notes:
 * - Some sites refuse to be embedded (X-Frame-Options / CSP frame-ancestors).
 *   The iframe will render empty in that case; the "open externally" button
 *   is the escape hatch.
 * - `sandbox` is intentionally permissive so common sites (docs, dashboards)
 *   actually work. Electron's renderer still isolates the iframe from the
 *   host via contextIsolation.
 */
export const IframeNodeBody = ({ node, onUpdate }: Props) => {
  const data = node.data as IframeNodeData;
  const url = data.url ?? "";
  const [editing, setEditing] = useState(!url);
  const [draft, setDraft] = useState(url);
  const [iframeKey, setIframeKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the draft in sync when the URL is changed externally (undo/redo,
  // CLI edits, etc.) so the address bar doesn't show stale text.
  useEffect(() => {
    setDraft(url);
  }, [url]);

  // Autofocus the input whenever we enter editing mode.
  useEffect(() => {
    if (editing) {
      const t = setTimeout(() => inputRef.current?.select(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [editing]);

  const commit = useCallback(() => {
    const next = normalizeUrl(draft.trim());
    if (next === url) {
      setEditing(false);
      return;
    }
    onUpdate(node.id, {
      data: { ...data, url: next },
      title: next ? prettyTitle(next) : node.title,
    });
    setEditing(false);
  }, [draft, url, onUpdate, node.id, node.title, data]);

  const cancel = useCallback(() => {
    setDraft(url);
    setEditing(false);
  }, [url]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    },
    [commit, cancel],
  );

  const handleOpenExternal = useCallback(() => {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }, [url]);

  const handleReload = useCallback(() => {
    setIframeKey((k) => k + 1);
  }, []);

  if (editing) {
    return (
      <div className="iframe-body iframe-body--empty">
        <div className="iframe-empty-inner">
          <div className="iframe-empty-label">Embed a web page</div>
          <input
            ref={inputRef}
            className="iframe-empty-input"
            type="url"
            value={draft}
            placeholder="https://example.com"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
          />
          <div className="iframe-empty-actions">
            {url && (
              <button className="iframe-empty-btn" onClick={cancel}>
                Cancel
              </button>
            )}
            <button
              className="iframe-empty-btn iframe-empty-btn--primary"
              onClick={commit}
              disabled={!draft.trim()}
            >
              Load
            </button>
          </div>
          <div className="iframe-empty-hint">
            Some sites block embedding — use "Open externally" to fall back to a browser.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="iframe-body">
      <div className="iframe-bar">
        <button
          className="iframe-bar-btn"
          onClick={handleReload}
          title="Reload"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2 6a4 4 0 016.9-2.8L10 4M10 2v2.5H7.5M10 6a4 4 0 01-6.9 2.8L2 8M2 10V7.5h2.5"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          className="iframe-bar-url"
          onClick={() => setEditing(true)}
          title="Edit URL"
        >
          <span className="iframe-bar-url-text">{url}</span>
        </button>
        <button
          className="iframe-bar-btn"
          onClick={handleOpenExternal}
          title="Open externally"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M5 2H2.5A.5.5 0 002 2.5v7A.5.5 0 002.5 10h7a.5.5 0 00.5-.5V7M7 2h3v3M5.5 6.5L10 2"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <iframe
        key={iframeKey}
        className="iframe-frame"
        src={url}
        title={node.title}
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
      />
    </div>
  );
};

/**
 * Add a protocol if the user typed a bare host, and strip any whitespace the
 * paste picked up. We don't try to rewrite anything more aggressive — if the
 * user typed nonsense the iframe will surface the failure.
 */
function normalizeUrl(input: string): string {
  if (!input) return "";
  if (/^[a-z]+:\/\//i.test(input)) return input;
  if (/^\/\//.test(input)) return `https:${input}`;
  return `https://${input}`;
}

/** Use the host as the default title so the header is meaningful at a glance. */
function prettyTitle(url: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url;
  }
}
