import { useCallback, useEffect, useRef, useState } from "react";
import "./index.css";
import type { CanvasNode, InfographicNodeData } from "../../types";

interface Props {
  node: CanvasNode;
  workspaceId?: string;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}

/**
 * LLM-generated visual content, inspired by Claude's "Visual and Interactive
 * Content" feature.
 *
 * Three UI states driven by `data.status`:
 *   - 'empty'      → prompt input + Generate button
 *   - 'generating' → spinner (regenerate is disabled)
 *   - 'ready'      → rendered content (HTML in an isolated <webview>, SVG
 *                    inline) with a Regenerate affordance
 *
 * Rendering rationale:
 *  - HTML content is produced by an LLM and may include arbitrary script /
 *    style, so we never inject it into the parent document. Instead we point
 *    a `<webview>` at the on-disk `file://…` path, which gets its own
 *    webContents (a proper OS-level isolation boundary) and cannot reach
 *    into the renderer.
 *  - SVG is static, well-understood, and inlining gives crisper rendering +
 *    accessibility (text selection, pointer events), so we embed it directly.
 *    We still write it to disk so the node survives reloads without
 *    re-running the model.
 */
export const InfographicNodeBody = ({ node, workspaceId, onUpdate }: Props) => {
  const data = node.data as InfographicNodeData;
  const status = data.status ?? (data.filePath ? "ready" : "empty");

  const [draft, setDraft] = useState(data.sourcePrompt ?? "");
  const [svgContent, setSvgContent] = useState<string>("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Keep the prompt draft in sync when the node's stored prompt changes
  // (undo/redo, external edits) so editing restarts from the persisted text.
  useEffect(() => {
    setDraft(data.sourcePrompt ?? "");
  }, [data.sourcePrompt]);

  // When the node is SVG and ready, pull the file contents so we can inline
  // them. HTML loads directly via <webview src="file://…">, so no read needed.
  useEffect(() => {
    if (status !== "ready") return;
    if (data.kind !== "svg") return;
    if (!workspaceId) return;
    const api = window.canvasWorkspace?.infographic;
    if (!api) return;
    let cancelled = false;
    void api.read(workspaceId, node.id, "svg").then((res) => {
      if (cancelled || !mountedRef.current) return;
      if (res.ok && typeof res.content === "string") {
        setSvgContent(res.content);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [status, data.kind, data.filePath, workspaceId, node.id]);

  const runGenerate = useCallback(
    async (prompt: string, kind: "html" | "svg") => {
      if (!workspaceId) return;
      const api = window.canvasWorkspace?.infographic;
      if (!api) {
        onUpdate(node.id, {
          data: {
            ...data,
            status: "error",
            error: "infographic API not available",
          },
        });
        return;
      }
      onUpdate(node.id, {
        data: {
          ...data,
          kind,
          sourcePrompt: prompt,
          status: "generating",
          error: undefined,
        },
      });
      const res = await api.generate(workspaceId, node.id, prompt, kind);
      if (!mountedRef.current) return;
      if (!res.ok || !res.filePath) {
        onUpdate(node.id, {
          data: {
            ...data,
            kind,
            sourcePrompt: prompt,
            status: "error",
            error: res.error ?? "generation failed",
          },
        });
        return;
      }
      if (res.kind === "svg" && typeof res.content === "string") {
        setSvgContent(res.content);
      }
      onUpdate(node.id, {
        data: {
          ...data,
          kind: res.kind ?? kind,
          filePath: res.filePath,
          sourcePrompt: prompt,
          status: "ready",
          error: undefined,
        },
        // Keep the node title in sync with the prompt so the header is
        // meaningful even before the user renames it.
        title:
          node.title && node.title !== "Infographic"
            ? node.title
            : deriveTitle(prompt),
      });
    },
    [workspaceId, node.id, node.title, data, onUpdate],
  );

  const handleGenerate = useCallback(
    (kind: "html" | "svg") => {
      const prompt = draft.trim();
      if (!prompt) return;
      void runGenerate(prompt, kind);
    },
    [draft, runGenerate],
  );

  const handleEdit = useCallback(() => {
    onUpdate(node.id, {
      data: { ...data, status: "empty", error: undefined },
    });
  }, [onUpdate, node.id, data]);

  // ─── Empty / edit state: prompt input ───────────────────────────────
  if (status === "empty" || status === "error") {
    const hasExisting = !!data.filePath;
    return (
      <div className="infographic-body infographic-body--empty">
        <div className="infographic-empty-inner">
          <div className="infographic-empty-label">
            Describe the visual you want
          </div>
          <textarea
            className="infographic-empty-input"
            value={draft}
            placeholder="e.g. A step-by-step flowchart of OAuth2 authorization code flow with labeled actors and arrows."
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            rows={4}
          />
          <div className="infographic-empty-actions">
            {hasExisting && (
              <button
                className="infographic-empty-btn"
                onClick={() =>
                  onUpdate(node.id, {
                    data: { ...data, status: "ready", error: undefined },
                  })
                }
              >
                Cancel
              </button>
            )}
            <button
              className="infographic-empty-btn"
              onClick={() => handleGenerate("svg")}
              disabled={!draft.trim()}
              title="Generate a static SVG"
            >
              SVG
            </button>
            <button
              className="infographic-empty-btn infographic-empty-btn--primary"
              onClick={() => handleGenerate("html")}
              disabled={!draft.trim()}
              title="Generate interactive HTML"
            >
              Generate
            </button>
          </div>
          {status === "error" && data.error && (
            <div className="infographic-empty-error">{data.error}</div>
          )}
          <div className="infographic-empty-hint">
            HTML renders in an isolated webview. SVG renders inline.
          </div>
        </div>
      </div>
    );
  }

  // ─── Generating state: spinner ──────────────────────────────────────
  if (status === "generating") {
    return (
      <div className="infographic-body infographic-body--loading">
        <div className="infographic-spinner" />
        <div className="infographic-loading-label">Generating…</div>
        <div className="infographic-loading-prompt">{data.sourcePrompt}</div>
      </div>
    );
  }

  // ─── Ready state: rendered content ──────────────────────────────────
  return (
    <div className="infographic-body">
      <div className="infographic-bar">
        <span
          className="infographic-bar-kind"
          title={`Kind: ${data.kind}`}
        >
          {data.kind.toUpperCase()}
        </span>
        <button
          className="infographic-bar-prompt"
          onClick={handleEdit}
          title="Edit prompt & regenerate"
        >
          <span className="infographic-bar-prompt-text">
            {data.sourcePrompt || "(no prompt)"}
          </span>
        </button>
        <button
          className="infographic-bar-btn"
          onClick={handleEdit}
          title="Regenerate"
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
      </div>
      {data.kind === "html" ? (
        <webview
          // webview can't consume arbitrary strings the way an <iframe
          // srcdoc> would, but pointing it at a real file URL gives us the
          // same isolation (its own webContents) plus persistence — a
          // canvas reload re-reads the same file without another model call.
          // The file path is URI-encoded to survive spaces/colons in the
          // workspace name.
          key={data.filePath}
          className="infographic-frame"
          src={toFileUrl(data.filePath)}
        />
      ) : (
        <div
          className="infographic-svg-wrap"
          dangerouslySetInnerHTML={{ __html: svgContent }}
        />
      )}
    </div>
  );
};

/**
 * Build a short, canvas-friendly node title from a prompt — the first line,
 * stripped of markdown punctuation, capped at 40 chars.
 */
function deriveTitle(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "Infographic";
  const stripped = firstLine.replace(/^[#>*\-+\d.\s]+/, "").trim();
  const source = stripped || firstLine;
  return source.length <= 40 ? source : `${source.slice(0, 40)}…`;
}

/**
 * Convert an absolute filesystem path to a `file://` URL safe for use in a
 * `<webview src>` attribute. Each path segment is `encodeURIComponent`'d so
 * that spaces, `#`, and other characters don't silently truncate the URL.
 */
function toFileUrl(filePath: string): string {
  if (!filePath) return "";
  // Normalize Windows backslashes so the URL is always forward-slash separated.
  const normalized = filePath.replace(/\\/g, "/");
  const encoded = normalized
    .split("/")
    .map((seg) => (seg ? encodeURIComponent(seg) : ""))
    .join("/");
  const prefix = encoded.startsWith("/") ? "file://" : "file:///";
  return `${prefix}${encoded}`;
}
