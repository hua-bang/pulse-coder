# Canvas Workspace Technical Plan

## 1. Architecture Overview
Local-first Electron app with a renderer UI and a main process for filesystem and PTY. The app stores all state in a workspace folder and a global config folder.

## 2. Recommended Tech Stack
- Electron + React for UI.
- Canvas library: React Flow (quick) or custom DOM layout.
- Terminal: xterm.js + node-pty.
- Editor: Monaco (code) + TipTap/BlockNote (markdown).
- Storage: JSON (fast) or SQLite (robust).

## 3. Process Model
- Main process: file access, PTY, settings, window state.
- Renderer: canvas, nodes, editor, terminal UI.
- IPC: typed channels for file read/write, PTY session ops.

## 4. Data Model
Workspace structure:
- workspace.json: canvas layout, nodes, groups.
- nodes/: node metadata.
- sessions/: terminal and agent session state.

Node schema:
- id, type, title, rect, z, data
- data depends on node type (file path, terminal id, agent config).

## 5. Canvas Rendering
- DOM nodes for tiles (easier rich content).
- Transform for pan/zoom using CSS matrix.
- Virtualize if node count grows large.

## 6. File Node
- Bind to a file path within workspace root.
- Read/write via main process with safe path checks.
- Watcher for external changes with conflict prompts.

## 7. Terminal Node
- Create PTY via node-pty in main process.
- Forward input/output via IPC streams.
- Optional tmux for session persistence and reconnect.

## 8. Agent Node
- Run agent in main or a worker process.
- Provide context pack (files + selected terminals + notes).
- Record agent actions as events for replay or audit.

## 9. Persistence
- Autosave layout on change with debounce.
- Store editor cursor/selection per file node.
- Restore all nodes and terminal sessions at launch.

## 10. Security and Safety
- Restrict file access to workspace root.
- Explicit user actions for running commands.
- Clear boundary between agent actions and user approval.

## 11. Performance
- Debounce layout writes.
- Stream terminal output; avoid DOM bloat.
- Lazy load heavy editors.

## 12. Packaging and Distribution
- macOS universal or arm64 builds.
- Auto-update via electron-updater (optional).

## 13. Risks and Mitigations
- PTY reliability: use tmux or restart strategy.
- File conflicts: detect and prompt merge.
- Canvas complexity: start with a simple node set and scale.

## 14. Open Questions
- Should file nodes support split view or tabs inside a tile?
- How to represent agent actions on the canvas (new node vs log panel)?
- Storage format: JSON or SQLite?
