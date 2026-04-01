---
name: canvas
description: Operate Pulse Canvas workspaces — read user-curated context, write results, create nodes
version: 1.0.0
---

# Pulse Canvas

Interact with canvas workspaces via the `pulse-canvas` CLI. The canvas is a shared workspace between humans and agents.

The current workspace ID is available via `$PULSE_CANVAS_WORKSPACE_ID` environment variable (auto-set by canvas). All `node` and `context` commands use it automatically — no need to pass workspace ID explicitly.

## Core Commands

### Read workspace context (start here)
```bash
pulse-canvas context --format json
```
Returns all nodes with structured info: file paths, frame groups, labels.

### List nodes
```bash
pulse-canvas node list --format json
```

### Read a node
```bash
pulse-canvas node read <nodeId> --format json
```

### Write to a node
```bash
pulse-canvas node write <nodeId> --content "..."
```

### Create a node
```bash
pulse-canvas node create --type file --title "Report" --data '{"content":"..."}'
```

### List workspaces
```bash
pulse-canvas workspace list --format json
```

## Usage Principles
- Before starting a task, run `context` to understand the user's canvas layout and intent
- Files on the canvas = files the user considers important — prioritize them
- Frame groups = file associations — understand files in the same group together
- After completing work, write results back to the canvas for the user to review
