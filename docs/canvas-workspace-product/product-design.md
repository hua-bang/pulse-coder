# Canvas Workspace Product Design

## 1. Product Vision
A local-first, single-window canvas where each workspace is a living map of work. Files, terminals, and agents are tiles on an infinite canvas. Users can see context and execution side by side without tab hunting.

## 2. Target Users and Scenarios
- Developers who juggle multiple files, shells, and tools while building.
- Power users who think spatially and want persistent working contexts.
- Researchers and writers who combine notes, code, and outputs.

Core scenarios:
- Feature work: spec -> code -> run -> debug, all on one canvas.
- Refactor: open key files, run tests, pin reference docs.
- Exploration: keep multiple terminals and notes visible.

## 3. Product Design
### 3.1 Core Concepts
- Workspace = one canvas + settings + data bindings.
- Tile (node) = a unit of content or action (file, terminal, agent).
- Canvas = infinite 2D space with zoom/pan, selection, grouping.

### 3.2 Node Types (MVP)
- File node: open/edit markdown or code file.
- Terminal node: real shell session with scrollback.
- Agent node: orchestrated coding agent with explicit context.

### 3.3 Canvas Interaction
- Pan/zoom with trackpad and mouse.
- Drag to position tiles, resize where applicable.
- Multi-select and group; group becomes a movable cluster.
- Snaplines and quick alignment helpers.
- Search and jump to nodes.

### 3.4 Workspace and Navigation
- Left navigator with file tree and workspace switcher.
- Drag files from navigator to canvas to create file nodes.
- Double-click canvas to create terminal or choose node type.

### 3.5 Agent Context Flow
- Agent node has an explicit context list.
- Context can be added by dragging file nodes into the agent node.
- Agent output can pin files or create new nodes.

### 3.6 Non-Goals (MVP)
- Multi-user collaboration.
- Cloud sync.
- Web deployment.

## 4. Experience Principles
- Local-first and fast.
- Minimal mode switches.
- Visual clarity over dense lists.
- Make state persistent and predictable.

## 5. Milestones
- M0: Canvas with tiles, persistence, and basic navigation.
- M1: File node with edit/save + search.
- M2: Terminal node with stable PTY session.
- M3: Agent node with context binding.
- M4: Polishing (grouping, alignment, global search).

## 6. Success Metrics (Local MVP)
- Time to resume work after reopening workspace.
- Number of context switches avoided.
- User reported flow satisfaction.
