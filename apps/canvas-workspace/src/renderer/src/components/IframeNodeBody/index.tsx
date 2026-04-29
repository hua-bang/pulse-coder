import { useCallback, useEffect, useRef, useState } from "react";
import "./index.css";
import type { CanvasNode, IframeNodeData } from "../../types";

type EditMode = "url" | "html" | "ai";

interface Props {
  node: CanvasNode;
  workspaceId?: string;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
  /** When true, overlay a transparent shield above the iframe/webview so
   *  the parent canvas keeps receiving mousemove/mouseup during resize.
   *  Without it, cross-origin iframes (and especially Electron `<webview>`)
   *  swallow the cursor's events and the resize handler stops updating. */
  isResizing?: boolean;
}

// ── Streaming shell ──────────────────────────────────────────────────
//
// Loaded as srcdoc during AI streaming. Contains:
//  - morphdom from CDN (with innerHTML fallback if CDN fails)
//  - A postMessage listener that morphs the DOM on each update
//
// The parent sends `{ type: 'morph', html }` with accumulated HTML.
// The shell extracts <style> → applies to <head>, extracts <body>
// content → morphdom diffs it in, strips <script> during streaming.
// When generation completes the parent swaps to the final srcdoc so
// scripts run.

const STREAMING_SHELL = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>*,*::before,*::after{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#fff}</style>
<script src="https://cdn.jsdelivr.net/npm/morphdom@2/dist/morphdom-umd.min.js"
  onerror="window.morphdom=function(f,t){if(typeof t==='string'){var d=document.createElement('div');d.innerHTML=t;while(f.firstChild)f.removeChild(f.firstChild);while(d.firstChild)f.appendChild(d.firstChild)}else if(f.parentNode){f.parentNode.replaceChild(t,f)}}"></script>
</head><body>
<div id="__mr__"></div>
<script>
var root=document.getElementById("__mr__"),styleEl=null,prevCss="";
function applyUpdate(html){
  var css="";
  html.replace(/<style[^>]*>([\\s\\S]*?)<\\/style>/gi,function(_,c){css+=c});
  if(css&&css!==prevCss){
    if(!styleEl){styleEl=document.createElement("style");styleEl.id="__sc__";document.head.appendChild(styleEl)}
    styleEl.textContent=css;prevCss=css
  }
  var body,bm=html.match(/<body[^>]*>([\\s\\S]*?)(<\\/body>|$)/i);
  if(bm){body=bm[1]}
  else{
    var bi=html.indexOf("<body");
    if(bi===-1)return;
    var gt=html.indexOf(">",bi);
    if(gt===-1)return;
    body=html.slice(gt+1)
  }
  body=body.replace(/<script[\\s\\S]*?(<\\/script>|$)/gi,"").trim();
  if(!body)return;
  var nx=document.createElement("div");nx.id="__mr__";nx.innerHTML=body;
  if(typeof morphdom==="function"){try{morphdom(root,nx)}catch(e){root.innerHTML=body}}
  else root.innerHTML=body
}
window.addEventListener("message",function(e){
  if(e.data&&e.data.type==="morph")applyUpdate(e.data.html)
});
window.parent.postMessage({type:"morph-ready"},"*");
</script>
</body></html>`;

// ── Component ────────────────────────────────────────────────────────

export const IframeNodeBody = ({ node, workspaceId, onUpdate, isResizing }: Props) => {
  const data = node.data as IframeNodeData;
  const mode = data.mode ?? "url";
  const url = data.url ?? "";
  const html = data.html ?? "";
  const savedPrompt = data.prompt ?? "";

  const hasContent = mode === "url" ? !!url : !!html;

  const [editing, setEditing] = useState(!hasContent);
  const [draftUrl, setDraftUrl] = useState(url);
  const [draftHtml, setDraftHtml] = useState(html);
  const [draftPrompt, setDraftPrompt] = useState(savedPrompt);
  const [draftMode, setDraftMode] = useState<EditMode>(mode === "ai" ? "ai" : mode === "html" ? "html" : "url");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [streamingActive, setStreamingActive] = useState(false);
  const [webviewKey, setWebviewKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const webviewRef = useRef<WebviewTag | null>(null);

  // ── Streaming refs (avoid re-renders per token) ────────────────────
  const streamIframeRef = useRef<HTMLIFrameElement>(null);
  const streamBuf = useRef("");
  const rafId = useRef(0);
  const shellReady = useRef(false);
  const pendingMorph = useRef<string | null>(null);

  // Keep drafts in sync when data is changed externally.
  useEffect(() => { setDraftUrl(url); }, [url]);
  useEffect(() => { setDraftHtml(html); }, [html]);
  useEffect(() => { setDraftPrompt(savedPrompt); }, [savedPrompt]);
  useEffect(() => { setDraftMode(mode === "ai" ? "ai" : mode === "html" ? "html" : "url"); }, [mode]);

  // Autofocus the relevant input whenever we enter editing mode.
  useEffect(() => {
    if (!editing) return undefined;
    const t = setTimeout(() => {
      if (draftMode === "url") inputRef.current?.select();
      else if (draftMode === "html") textareaRef.current?.focus();
      else promptRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [editing, draftMode]);

  // ── Listen for morph-ready from the streaming shell ────────────────
  useEffect(() => {
    if (!streamingActive) {
      shellReady.current = false;
      return;
    }

    const handler = (e: MessageEvent) => {
      if (e.data?.type === "morph-ready") {
        shellReady.current = true;
        // Flush any HTML that arrived before the shell was ready
        if (pendingMorph.current && streamIframeRef.current?.contentWindow) {
          streamIframeRef.current.contentWindow.postMessage(
            { type: "morph", html: pendingMorph.current }, "*",
          );
          pendingMorph.current = null;
        }
      }
    };

    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      shellReady.current = false;
    };
  }, [streamingActive]);

  // Register the webview's webContents with main (URL mode only).
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

  // ── Send accumulated HTML to the streaming iframe via postMessage ──

  const flushToIframe = useCallback(() => {
    const currentHtml = streamBuf.current;
    const win = streamIframeRef.current?.contentWindow;

    if (win && shellReady.current) {
      win.postMessage({ type: "morph", html: currentHtml }, "*");
    } else {
      pendingMorph.current = currentHtml;
    }
  }, []);

  // ── Commit (URL / HTML) ────────────────────────────────────────────

  const commit = useCallback(() => {
    if (draftMode === "url") {
      const next = normalizeUrl(draftUrl.trim());
      onUpdate(node.id, {
        data: { ...data, url: next, mode: "url" },
        title: next ? prettyTitle(next) : node.title,
      });
    } else if (draftMode === "html") {
      onUpdate(node.id, {
        data: { ...data, html: draftHtml, mode: "html" },
        title: node.title === "Web" ? "HTML" : node.title,
      });
    }
    setEditing(false);
  }, [draftMode, draftUrl, draftHtml, onUpdate, node.id, node.title, data]);

  // ── Streaming AI generation ────────────────────────────────────────

  const startStream = useCallback(async (
    prompt: string,
    opts: { fromEditor?: boolean } = {},
  ) => {
    setGenerating(true);
    setGenError(null);
    setStreamingActive(true);
    streamBuf.current = "";
    shellReady.current = false;
    pendingMorph.current = null;

    if (opts.fromEditor) setEditing(false);

    try {
      const llm = window.canvasWorkspace.llm;
      const startResult = await llm.streamHTML(prompt);

      if (!startResult.ok || !startResult.requestId) {
        setGenError(startResult.error ?? "Failed to start generation");
        setGenerating(false);
        setStreamingActive(false);
        if (opts.fromEditor) setEditing(true);
        return;
      }

      const requestId = startResult.requestId;

      const unsub = llm.onHTMLDelta(requestId, (delta) => {
        streamBuf.current += delta;
        if (!rafId.current) {
          rafId.current = requestAnimationFrame(() => {
            rafId.current = 0;
            flushToIframe();
          });
        }
      });

      const unsubComplete = llm.onHTMLComplete(requestId, (result) => {
        unsub();
        unsubComplete();
        if (rafId.current) {
          cancelAnimationFrame(rafId.current);
          rafId.current = 0;
        }

        if (result.ok && result.html) {
          onUpdate(node.id, {
            data: { ...data, html: result.html, prompt, mode: "ai" },
            title: node.title === "Web" ? "AI Visual" : node.title,
          });
        } else {
          setGenError(result.error ?? "Generation failed");
          if (opts.fromEditor) setEditing(true);
        }
        setStreamingActive(false);
        setGenerating(false);
      });
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err));
      setStreamingActive(false);
      setGenerating(false);
      if (opts.fromEditor) setEditing(true);
    }
  }, [flushToIframe, onUpdate, node.id, node.title, data]);

  const handleGenerate = useCallback(
    () => startStream(draftPrompt.trim(), { fromEditor: true }),
    [startStream, draftPrompt],
  );

  const handleRegenerate = useCallback(
    () => startStream(savedPrompt.trim()),
    [startStream, savedPrompt],
  );

  const cancel = useCallback(() => {
    setDraftUrl(url);
    setDraftHtml(html);
    setDraftPrompt(savedPrompt);
    setDraftMode(mode === "ai" ? "ai" : mode === "html" ? "html" : "url");
    setGenError(null);
    setEditing(false);
  }, [url, html, savedPrompt, mode]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    },
    [commit, cancel],
  );

  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    },
    [commit, cancel],
  );

  const handlePromptKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleGenerate();
      } else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    },
    [handleGenerate, cancel],
  );

  const handleOpenExternal = useCallback(() => {
    if (mode === "url" && url) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }, [mode, url]);

  const handleReload = useCallback(() => {
    if (mode !== "url") {
      setWebviewKey((k) => k + 1);
      return;
    }
    const el = webviewRef.current;
    if (el && typeof el.reload === "function") {
      try { el.reload(); return; } catch { /* fall through */ }
    }
    setWebviewKey((k) => k + 1);
  }, [mode]);

  // ── Editing state ──────────────────────────────────────────────────

  if (editing) {
    const canCommit =
      draftMode === "url" ? !!draftUrl.trim() :
      draftMode === "html" ? !!draftHtml.trim() :
      !!draftPrompt.trim();

    return (
      <div className="iframe-body iframe-body--empty">
        <div className="iframe-empty-inner">
          <div className="iframe-mode-tabs">
            <button
              className={`iframe-mode-tab${draftMode === "url" ? " iframe-mode-tab--active" : ""}`}
              onClick={() => setDraftMode("url")}
              disabled={generating}
            >
              URL
            </button>
            <button
              className={`iframe-mode-tab${draftMode === "html" ? " iframe-mode-tab--active" : ""}`}
              onClick={() => setDraftMode("html")}
              disabled={generating}
            >
              HTML
            </button>
            <button
              className={`iframe-mode-tab${draftMode === "ai" ? " iframe-mode-tab--active" : ""}`}
              onClick={() => setDraftMode("ai")}
              disabled={generating}
            >
              AI
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
          ) : draftMode === "html" ? (
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
          ) : (
            <>
              <div className="iframe-empty-label">Describe what to generate</div>
              <textarea
                ref={promptRef}
                className="iframe-empty-textarea iframe-empty-textarea--prompt"
                value={draftPrompt}
                placeholder={"A pie chart showing Q1 revenue by region…\nAn interactive to-do list with drag & drop…\nA flow diagram of the CI/CD pipeline…"}
                onChange={(e) => setDraftPrompt(e.target.value)}
                onKeyDown={handlePromptKeyDown}
                spellCheck={false}
                disabled={generating}
              />
              {genError && (
                <div className="iframe-gen-error">{genError}</div>
              )}
            </>
          )}

          <div className="iframe-empty-actions">
            {hasContent && !generating && (
              <button className="iframe-empty-btn" onClick={cancel}>
                Cancel
              </button>
            )}
            {draftMode === "ai" ? (
              <button
                className="iframe-empty-btn iframe-empty-btn--primary iframe-empty-btn--ai"
                onClick={() => void handleGenerate()}
                disabled={!canCommit || generating}
              >
                {generating ? (
                  <>
                    <span className="iframe-spinner" />
                    Generating…
                  </>
                ) : (
                  <>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                      <path d="M8 1.5l1.85 4.15L14 7.5l-4.15 1.85L8 13.5l-1.85-4.15L2 7.5l4.15-1.85L8 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                    </svg>
                    Generate
                  </>
                )}
              </button>
            ) : (
              <button
                className="iframe-empty-btn iframe-empty-btn--primary"
                onClick={commit}
                disabled={!canCommit}
              >
                {draftMode === "url" ? "Load" : "Render"}
              </button>
            )}
          </div>

          <div className="iframe-empty-hint">
            {draftMode === "url"
              ? 'Some sites block embedding — use "Open externally" to fall back to a browser.'
              : draftMode === "html"
              ? "Cmd/Ctrl+Enter to confirm. Scripts are sandboxed."
              : "Cmd/Ctrl+Enter to generate. Describe a chart, diagram, UI, or any visual."}
          </div>
        </div>
      </div>
    );
  }

  // ── Rendered state ─────────────────────────────────────────────────

  const renderMode = mode === "url" ? "url" : "html";

  return (
    <div className="iframe-body">
      <div className="iframe-bar">
        <button
          className="iframe-bar-btn"
          onClick={handleReload}
          title="Reload"
          disabled={generating}
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
        ) : mode === "ai" ? (
          <button
            className="iframe-bar-url iframe-bar-url--html"
            onClick={() => !generating && setEditing(true)}
            title={generating ? "Generating…" : "Edit prompt"}
          >
            <span className="iframe-bar-badge iframe-bar-badge--ai">AI</span>
            {generating ? (
              <span className="iframe-bar-streaming">
                <span className="iframe-spinner iframe-spinner--small" />
                <span className="iframe-bar-url-text">Generating…</span>
              </span>
            ) : (
              <span className="iframe-bar-url-text">
                {savedPrompt.length > 80 ? savedPrompt.slice(0, 80) + "…" : savedPrompt}
              </span>
            )}
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

        {mode === "ai" && !generating && (
          <button
            className="iframe-bar-btn"
            onClick={() => void handleRegenerate()}
            title="Regenerate"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 1.5l1.85 4.15L14 7.5l-4.15 1.85L8 13.5l-1.85-4.15L2 7.5l4.15-1.85L8 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
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

      <div className={`iframe-frame-wrapper${streamingActive ? " iframe-frame-wrapper--streaming" : ""}`}>
        {streamingActive && <div className="iframe-shimmer-bar" />}
        {isResizing && <div className="iframe-pointer-shield" aria-hidden="true" />}
        {renderMode === "url" ? (
          <webview
            ref={webviewRef as unknown as React.Ref<HTMLWebViewElement>}
            key={webviewKey}
            className="iframe-frame"
            src={url}
            allowpopups={true as unknown as undefined}
          />
        ) : streamingActive ? (
          <iframe
            ref={streamIframeRef}
            key="stream-shell"
            className="iframe-frame"
            srcDoc={STREAMING_SHELL}
            sandbox="allow-scripts"
            title="Generating…"
          />
        ) : (
          <iframe
            key={webviewKey}
            className="iframe-frame"
            srcDoc={html}
            sandbox="allow-scripts"
            title={mode === "ai" ? "AI-generated preview" : "HTML preview"}
          />
        )}
      </div>
    </div>
  );
};

function normalizeUrl(input: string): string {
  if (!input) return "";
  if (/^[a-z]+:\/\//i.test(input)) return input;
  if (/^\/\//.test(input)) return `https:${input}`;
  return `https://${input}`;
}

function prettyTitle(url: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url;
  }
}

interface WebviewTag extends HTMLElement {
  getWebContentsId(): number;
  reload(): void;
}
