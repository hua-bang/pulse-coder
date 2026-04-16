import { useCallback, useEffect, useRef, useState } from "react";
import "./index.css";
import type { CanvasNode, IframeNodeData } from "../../types";

interface Props {
  node: CanvasNode;
  workspaceId?: string;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}

/**
 * Renders an external web page in an Electron `<webview>` tag, **or** renders
 * user-supplied HTML in a sandboxed `<iframe srcdoc>`.
 *
 * URL mode (`mode: 'url'`, default):
 *   A `<webview>` hosts its own `webContents` (like an isolated mini-browser),
 *   which lets us do two things a plain iframe can't:
 *    1. **Read the rendered DOM.** When the webview attaches we register its
 *       `webContentsId` with main. The Canvas Agent's `canvas_read_node` tool
 *       then pulls the post-JS DOM text directly out of that webContents — so
 *       SPAs, pages that require auth cookies, etc. all become readable.
 *    2. **Bypass X-Frame-Options / CSP frame-ancestors.** A `<webview>` isn't
 *       subject to those directives the way a nested browsing context is, so a
 *       lot of sites that refuse to embed in `<iframe>` render normally here.
 *
 * HTML mode (`mode: 'html'`):
 *   Renders raw HTML the user typed into the editor via `<iframe srcdoc>`.
 *   The iframe is sandboxed — scripts are allowed so interactive demos work,
 *   but it cannot navigate the parent or access its origin.
 *
 * Empty URL/HTML → show an input. Non-empty → show the content.
 */
export const IframeNodeBody = ({ node, workspaceId, onUpdate }: Props) => {
  const data = node.data as IframeNodeData;
  const mode = data.mode ?? "url";
  const url = data.url ?? "";
  const html = data.html ?? "";

  const hasContent = mode === "url" ? !!url : !!html;

  const [editing, setEditing] = useState(!hasContent);
  const [draftUrl, setDraftUrl] = useState(url);
  const [draftHtml, setDraftHtml] = useState(html);
  const [draftMode, setDraftMode] = useState<"url" | "html">(mode);
  const [webviewKey, setWebviewKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const webviewRef = useRef<WebviewTag | null>(null);

  // Keep drafts in sync when data is changed externally (undo/redo, CLI edits).
  useEffect(() => { setDraftUrl(url); }, [url]);
  useEffect(() => { setDraftHtml(html); }, [html]);
  useEffect(() => { setDraftMode(mode); }, [mode]);

  // Autofocus the relevant input whenever we enter editing mode.
  useEffect(() => {
    if (!editing) return undefined;
    const t = setTimeout(() => {
      if (draftMode === "url") inputRef.current?.select();
      else textareaRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [editing, draftMode]);

  // Register the webview's webContents with main so the Canvas Agent can
  // pull rendered text out of it (URL mode only).
  useEffect(() => {
    if (editing || mode !== "url") return;
    if (!workspaceId) return;
    const el = webviewRef.current;
    if (!el) return;

    const api = window.canvasWorkspace.iframe;

    let registered = false;

    const tryRegister = (via: string) => {
      if (registered) return;
      try {
        const id = el.getWebContentsId();
        if (typeof id === "number") {
          registered = true;
          void api.registerWebview(workspaceId, node.id, id);
          // eslint-disable-next-line no-console
          console.log(
            `[link-node] registered webContents ${id} for node ${node.id} (via ${via})`,
          );
        }
      } catch (err) {
        if (via === "mount") {
          // eslint-disable-next-line no-console
          console.debug(
            `[link-node] getWebContentsId not ready on mount: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    };

    tryRegister("mount");

    const onAttach = () => tryRegister("did-attach");
    const onDomReady = () => tryRegister("dom-ready");
    el.addEventListener("did-attach", onAttach);
    el.addEventListener("dom-ready", onDomReady);

    return () => {
      el.removeEventListener("did-attach", onAttach);
      el.removeEventListener("dom-ready", onDomReady);
      if (registered) {
        void api.unregisterWebview(workspaceId, node.id);
      }
    };
  }, [workspaceId, node.id, editing, url, mode, webviewKey]);

  const commit = useCallback(() => {
    if (draftMode === "url") {
      const next = normalizeUrl(draftUrl.trim());
      onUpdate(node.id, {
        data: { ...data, url: next, mode: "url" },
        title: next ? prettyTitle(next) : node.title,
      });
    } else {
      onUpdate(node.id, {
        data: { ...data, html: draftHtml, mode: "html" },
        title: node.title === "Web" ? "HTML" : node.title,
      });
    }
    setEditing(false);
  }, [draftMode, draftUrl, draftHtml, onUpdate, node.id, node.title, data]);

  const cancel = useCallback(() => {
    setDraftUrl(url);
    setDraftHtml(html);
    setDraftMode(mode);
    setEditing(false);
  }, [url, html, mode]);

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

  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Cmd/Ctrl+Enter to confirm HTML
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
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
    if (mode === "url" && url) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }, [mode, url]);

  const handleReload = useCallback(() => {
    if (mode === "html") {
      // Force re-render the srcdoc iframe
      setWebviewKey((k) => k + 1);
      return;
    }
    const el = webviewRef.current;
    if (el && typeof el.reload === "function") {
      try {
        el.reload();
        return;
      } catch {
        // fall through to remount
      }
    }
    setWebviewKey((k) => k + 1);
  }, [mode]);

  // ── Editing state ──────────────────────────────────────────────────────

  if (editing) {
    const canCommit = draftMode === "url" ? !!draftUrl.trim() : !!draftHtml.trim();

    return (
      <div className="iframe-body iframe-body--empty">
        <div className="iframe-empty-inner">
          {/* Tab switcher */}
          <div className="iframe-mode-tabs">
            <button
              className={`iframe-mode-tab${draftMode === "url" ? " iframe-mode-tab--active" : ""}`}
              onClick={() => setDraftMode("url")}
            >
              URL
            </button>
            <button
              className={`iframe-mode-tab${draftMode === "html" ? " iframe-mode-tab--active" : ""}`}
              onClick={() => setDraftMode("html")}
            >
              HTML
            </button>
          </div>

          {draftMode === "url" ? (
            <>
              <div className="iframe-empty-label">Embed a web page</div>
              <input
                ref={inputRef}
                className="iframe-empty-input"
                type="url"
                value={draftUrl}
                placeholder="https://example.com"
                onChange={(e) => setDraftUrl(e.target.value)}
                onKeyDown={handleKeyDown}
                spellCheck={false}
              />
            </>
          ) : (
            <>
              <div className="iframe-empty-label">Render HTML</div>
              <textarea
                ref={textareaRef}
                className="iframe-empty-textarea"
                value={draftHtml}
                placeholder={'<h1>Hello</h1>\n<p>Type your HTML here…</p>'}
                onChange={(e) => setDraftHtml(e.target.value)}
                onKeyDown={handleTextareaKeyDown}
                spellCheck={false}
              />
            </>
          )}

          <div className="iframe-empty-actions">
            {hasContent && (
              <button className="iframe-empty-btn" onClick={cancel}>
                Cancel
              </button>
            )}
            <button
              className="iframe-empty-btn iframe-empty-btn--primary"
              onClick={commit}
              disabled={!canCommit}
            >
              {draftMode === "url" ? "Load" : "Render"}
            </button>
          </div>

          <div className="iframe-empty-hint">
            {draftMode === "url"
              ? 'Some sites block embedding — use "Open externally" to fall back to a browser.'
              : "Cmd/Ctrl+Enter to confirm. Scripts are sandboxed."}
          </div>
        </div>
      </div>
    );
  }

  // ── Rendered state ─────────────────────────────────────────────────────

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

        {mode === "url" ? (
          <button
            className="iframe-bar-url"
            onClick={() => setEditing(true)}
            title="Edit URL"
          >
            <span className="iframe-bar-url-text">{url}</span>
          </button>
        ) : (
          <button
            className="iframe-bar-url iframe-bar-url--html"
            onClick={() => setEditing(true)}
            title="Edit HTML"
          >
            <span className="iframe-bar-badge">HTML</span>
            <span className="iframe-bar-url-text">
              {html.length > 80 ? html.slice(0, 80) + "…" : html}
            </span>
          </button>
        )}

        {mode === "url" && (
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
        )}
      </div>

      {mode === "url" ? (
        <webview
          ref={webviewRef as unknown as React.Ref<HTMLWebViewElement>}
          key={webviewKey}
          className="iframe-frame"
          src={url}
          allowpopups={true as unknown as undefined}
        />
      ) : (
        <iframe
          key={webviewKey}
          className="iframe-frame"
          srcDoc={html}
          sandbox="allow-scripts"
          title="HTML preview"
        />
      )}
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

// Minimal shape of Electron's `<webview>` — we only use the bits we call.
// (Avoids pulling a full Electron types dep into the renderer.)
interface WebviewTag extends HTMLElement {
  getWebContentsId(): number;
  reload(): void;
}
