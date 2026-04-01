---
name: canvas-bootstrap
description: Deep-research a topic and build a structured canvas workspace with spatially organized frames and content
version: 2.0.0
---

# Canvas Bootstrap

Given a topic or task, deeply research it, then build a structured canvas workspace where frames and content nodes are spatially aligned.

## Workflow

### Phase 1: Deep Research (spend most of your time here)

Do NOT create any nodes yet. First, thoroughly understand the topic:

1. **Clarify scope** — What exactly does the user want? What's the boundary?
2. **Web search** — Search for 3-5 different angles on the topic. Read the results carefully.
3. **Cross-reference** — Compare sources. Note agreements, contradictions, and gaps.
4. **Read local context** — If related to a project, read relevant files in the codebase.
5. **Synthesize** — Distill findings into structured knowledge. Identify:
   - Core concepts (what must be understood)
   - Key decisions (what choices exist)
   - Action items (what needs to be done)
   - Open questions (what's still unclear)

The quality of the canvas depends entirely on the quality of the research. A well-researched canvas with 5 nodes beats a shallow canvas with 20 nodes.

### Phase 2: Plan Canvas Structure

Based on your research, design the layout. Think in terms of **regions**:

```
┌──────── Frame A (x:50) ────────┐  ┌──────── Frame B (x:750) ────────┐
│                                 │  │                                  │
│  [File: Summary]    (x:70)      │  │  [File: Analysis]    (x:770)    │
│  [File: Key Facts]  (x:70)      │  │  [File: Comparisons] (x:770)   │
│                                 │  │                                  │
└─────────────────────────────────┘  └──────────────────────────────────┘

┌──────── Frame C (x:50) ────────────────────────────────────────────────┐
│                                                                         │
│  [File: Tasks]  (x:70)           [File: Timeline]  (x:770)            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key rule**: File nodes must be positioned INSIDE their parent frame's bounds.

### Phase 3: Create Workspace

```bash
pulse-canvas workspace create "<topic>" --format json
```

### Phase 4: Create Nodes with Explicit Positions

**Coordinate system**: x=0, y=0 is top-left. Positive x goes right, positive y goes down.

#### Step 1: Create frames (large containers)

Frames are large rectangles that visually group content. Use `--width` and `--height` to make them big enough to contain their child nodes.

```bash
# Row 1: two frames side by side
pulse-canvas node create --type frame --title "Overview" \
  --x 50 --y 50 --width 680 --height 500 \
  --data '{"label":"Core concepts","color":"#4a90d9"}' --format json

pulse-canvas node create --type frame --title "Research" \
  --x 780 --y 50 --width 680 --height 500 \
  --data '{"label":"Deep analysis","color":"#9065b0"}' --format json

# Row 2: a wide frame spanning the full width
pulse-canvas node create --type frame --title "Action Plan" \
  --x 50 --y 600 --width 1410 --height 450 \
  --data '{"label":"Next steps","color":"#d94a4a"}' --format json
```

#### Step 2: Create file nodes INSIDE frames

Position file nodes within their parent frame's bounds. Leave ~20px margin from frame edges.

```bash
# Inside "Overview" frame (frame is at x:50, y:50, 680x500)
pulse-canvas node create --type file --title "Summary" \
  --x 70 --y 100 --width 300 --height 420 \
  --data '{"content":"# Summary\n\n...synthesized content..."}' --format json

pulse-canvas node create --type file --title "Key Concepts" \
  --x 390 --y 100 --width 300 --height 420 \
  --data '{"content":"# Key Concepts\n\n..."}' --format json

# Inside "Research" frame (frame is at x:780, y:50, 680x500)
pulse-canvas node create --type file --title "Analysis" \
  --x 800 --y 100 --width 300 --height 420 \
  --data '{"content":"# Analysis\n\n..."}' --format json

pulse-canvas node create --type file --title "Sources" \
  --x 1120 --y 100 --width 300 --height 420 \
  --data '{"content":"# Sources & References\n\n..."}' --format json

# Inside "Action Plan" frame (frame is at x:50, y:600, 1410x450)
pulse-canvas node create --type file --title "Tasks" \
  --x 70 --y 650 --width 420 --height 360 \
  --data '{"content":"# Tasks\n\n- [ ] ..."}' --format json
```

#### Step 3: Terminal nodes (only if needed)

```bash
# Place inside or near a relevant frame
pulse-canvas node create --type terminal --title "Dev" \
  --x 520 --y 650 \
  --data '{"cwd":"/path/to/project"}' --format json
```

### Phase 5: Verify

```bash
pulse-canvas context --format json
```

Tell the user what you created and what the key findings were.

## Position Reference

### Standard 2-column layout (recommended)

```
Frame 1: x:50   y:50   w:680  h:500   |  Frame 2: x:780  y:50   w:680  h:500
  File A: x:70   y:100  w:300  h:420   |    File C: x:800  y:100  w:300  h:420
  File B: x:390  y:100  w:300  h:420   |    File D: x:1120 y:100  w:300  h:420

Frame 3: x:50   y:600  w:1410 h:450
  File E: x:70   y:650  w:420  h:360
  File F: x:520  y:650  w:420  h:360
  File G: x:970  y:650  w:420  h:360
```

### Standard 3-column layout

```
Frame 1: x:50   y:50   w:450  h:500
Frame 2: x:530  y:50   w:450  h:500
Frame 3: x:1010 y:50   w:450  h:500
```

## Frame Colors

| Purpose | Color | Hex |
|---------|-------|-----|
| Overview / Summary | Blue | `#4a90d9` |
| Research / Analysis | Purple | `#9065b0` |
| Tasks / Actions | Red | `#d94a4a` |
| Implementation / Code | Green | `#4ad97a` |
| Notes / Decisions | Orange | `#d9a54a` |

## Quality Checklist

- [ ] Every file node has **synthesized** content (not raw search results)
- [ ] File nodes are **positioned inside** their parent frame
- [ ] Frames are sized large enough to contain their children
- [ ] No more than 3-4 frames and 6-8 file nodes
- [ ] The canvas tells a coherent story from left to right or top to bottom

## Anti-patterns

- **Nodes outside frames** — always place file nodes within a frame's bounds
- **Empty content** — every file node must have real, useful text
- **Too many nodes** — focused and deep beats broad and shallow
- **Skipping research** — don't create nodes until you've thoroughly researched
- **Raw dumps** — synthesize and structure, never paste raw search output
