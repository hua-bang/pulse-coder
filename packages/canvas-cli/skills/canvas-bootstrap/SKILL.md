---
name: canvas-bootstrap
description: Research a topic and build a structured canvas workspace with frames, files, and terminals
version: 1.0.0
---

# Canvas Bootstrap

Given a topic or task, research relevant information and create a structured canvas workspace with organized nodes.

## Workflow

### 1. Create workspace (if needed)

If no workspace is active (`$PULSE_CANVAS_WORKSPACE_ID` is not set), create one:

```bash
pulse-canvas workspace create "<topic>" --format json
```

Then use the returned workspace ID with `--workspace <id>` for subsequent commands.

### 2. Plan the layout

Before creating nodes, plan a logical structure:

- **Frames** group related content (e.g. "Research", "Tasks", "Architecture")
- **File nodes** hold documents, notes, code snippets, plans
- **Terminal nodes** represent execution contexts (e.g. "Build", "Test")

Arrange nodes spatially — related items should be near each other.

### 3. Create frames first (they define regions)

```bash
pulse-canvas node create --type frame --title "Research" --data '{"label":"Background research","color":"#9065b0"}' --format json
pulse-canvas node create --type frame --title "Tasks" --data '{"label":"Action items","color":"#4a90d9"}' --format json
```

### 4. Create file nodes with content

```bash
pulse-canvas node create --type file --title "Overview" --data '{"content":"# Topic Overview\n\n..."}' --format json
pulse-canvas node create --type file --title "Key Findings" --data '{"content":"# Key Findings\n\n- ..."}' --format json
```

For richer content, use bash to pipe content:

```bash
pulse-canvas node create --type file --title "Detailed Notes" --format json
# Then write content to the created node:
pulse-canvas node write <nodeId> --content "$(cat <<'CONTENT'
# Detailed Notes

## Section 1
...

## Section 2
...
CONTENT
)"
```

### 5. Create terminal nodes for execution contexts

```bash
pulse-canvas node create --type terminal --title "Dev Server" --data '{"cwd":"/path/to/project"}' --format json
```

Note: Terminal nodes created via CLI have no active PTY session. They serve as placeholders that the user can activate in the canvas UI.

## Layout Guidelines

Use `--data` with position hints when creating nodes to form a logical grid:

| Region | Purpose | Suggested color |
|--------|---------|-----------------|
| Overview | High-level summary, goals | `#4a90d9` (blue) |
| Research | Background info, references | `#9065b0` (purple) |
| Tasks | Action items, todos | `#d94a4a` (red) |
| Implementation | Code, architecture | `#4ad97a` (green) |
| Notes | Meeting notes, decisions | `#d9a54a` (orange) |

## Example: Bootstrap a canvas for "Build a REST API"

```bash
# Create workspace
pulse-canvas workspace create "REST API Project" --format json
# → { "id": "ws-123..." }

# Create frames
pulse-canvas node create -w ws-123 --type frame --title "Architecture" --data '{"label":"System design","color":"#4a90d9"}' --format json
pulse-canvas node create -w ws-123 --type frame --title "Tasks" --data '{"label":"Sprint backlog","color":"#d94a4a"}' --format json

# Create file nodes
pulse-canvas node create -w ws-123 --type file --title "API Design" --data '{"content":"# API Design\n\n## Endpoints\n\n- GET /users\n- POST /users\n- GET /users/:id\n\n## Auth\nJWT bearer tokens\n"}' --format json
pulse-canvas node create -w ws-123 --type file --title "Tech Stack" --data '{"content":"# Tech Stack\n\n- Runtime: Node.js + TypeScript\n- Framework: Hono\n- Database: PostgreSQL\n- ORM: Drizzle\n"}' --format json
pulse-canvas node create -w ws-123 --type file --title "Sprint Tasks" --data '{"content":"# Sprint 1\n\n- [ ] Project setup\n- [ ] Database schema\n- [ ] Auth middleware\n- [ ] CRUD endpoints\n- [ ] Tests\n"}' --format json

# Create terminal node
pulse-canvas node create -w ws-123 --type terminal --title "Dev" --data '{"cwd":"/home/user/api-project"}' --format json
```

## Tips

- Start with 2-3 frames to organize the space, then add file nodes within each logical group
- Write concise but useful content — the canvas is for quick reference, not full documents
- Use markdown formatting in file nodes for readability
- If the topic is broad, create a "Overview" file node first with a high-level summary
- After creating all nodes, run `pulse-canvas context --format json` to verify the workspace structure
