---
name: canvas-bootstrap
description: Deep-research a topic and build a structured canvas workspace with spatially organized frames and content
version: 3.0.0
---

# Canvas Bootstrap

Given a topic or task, deeply research it, then build a structured canvas workspace where frames group related content nodes spatially.

## Workflow

### Phase 1: Deep Research (most important phase)

Do NOT create any nodes yet. Research thoroughly first:

1. **Clarify scope** — What exactly does the user want? What's the boundary?
2. **Multi-angle search** — Search 3-5 different aspects of the topic
3. **Cross-reference** — Compare sources, note conflicts and consensus
4. **Read local context** — Check related project files if applicable
5. **Synthesize** — Organize findings into a structured outline:
   - What are the natural **categories** of information? (these become frames)
   - Within each category, what **distinct pieces** of content exist? (these become file nodes)
   - What requires **execution/interaction**? (these become terminal nodes)

### Phase 2: Plan Dynamic Layout

Based on research, determine the structure organically. Do NOT use a fixed template.

**Planning rules:**
- Each frame = one logical **category** of your research findings
- Each file node = one **distinct document** within that category
- A frame should have **2-4 file nodes** (if only 1, merge into another frame; if more than 4, split the frame)
- Total: aim for 3-6 frames with 2-4 nodes each

**Think through your plan like this:**

> Research found 4 major areas:
> 1. "Historical Context" — 3 aspects: timeline, key figures, turning points → 1 frame, 3 files
> 2. "Core Concepts" — 2 aspects: fundamentals, advanced topics → 1 frame, 2 files  
> 3. "Current State" — 3 aspects: landscape, key players, trends → 1 frame, 3 files
> 4. "Action Items" — 2 aspects: short-term tasks, long-term goals → 1 frame, 2 files
> Total: 4 frames, 10 files → good balance

### Phase 3: Create Workspace

```bash
pulse-canvas workspace create "<topic>" --format json
```

### Phase 4: Create Nodes with Dynamic Layout

#### Layout algorithm

Frames are arranged in a grid. Each frame is sized to fit its children.

**Important:** Frame titles float 34px ABOVE the frame top edge. Use a large enough GAP between frame rows so that file cards from the row above don't cover the next row's frame title.

**Constants:**
- `FRAME_PAD = 24` — padding inside frame edges (all sides)
- `GAP = 100` — gap between frames (must be ≥80 to avoid title overlap)
- `FILE_W = 300` — file node width
- `FILE_H = 360` — file node height
- `COL_GAP = 24` — gap between file nodes inside a frame

**For each frame, calculate dimensions based on child count:**
- Frame width = `FRAME_PAD*2 + N_COLS * FILE_W + (N_COLS-1) * COL_GAP`
  - 1 file → 1 col, width = 348
  - 2 files → 2 cols, width = 672
  - 3 files → 3 cols, width = 996
  - 4 files → 2 cols × 2 rows, width = 672
- Frame height = `FRAME_PAD*2 + N_ROWS * FILE_H + (N_ROWS-1) * COL_GAP`
  - 1 row → height = 408
  - 2 rows → height = 792

**Arrange frames left-to-right, wrapping to a new row when exceeding ~1500px:**

```
Row 1:  Frame_A (at x:50)          Frame_B (at x:50 + wA + GAP)     Frame_C (if fits)
Row 2:  Frame_D (at x:50, y: ...)  Frame_E ...
```

Row 2 y = row1_y + max_frame_height + GAP (e.g. 50 + 408 + 100 = 558)

**Place file nodes inside each frame:**
```
Frame top-left = (fx, fy)
File[0]: x = fx + FRAME_PAD,                        y = fy + FRAME_PAD
File[1]: x = fx + FRAME_PAD + FILE_W + COL_GAP,     y = fy + FRAME_PAD
File[2]: x = fx + FRAME_PAD,                        y = fy + FRAME_PAD + FILE_H + COL_GAP  (row 2)
...
```

#### Example: 4 frames with varying child counts

```bash
# Frame 1: "Historical Context" — 3 files (3 cols)
# Frame: x=50, y=50, w=996, h=408
pulse-canvas node create --type frame --title "Historical Context" \
  --x 50 --y 50 --width 996 --height 408 \
  --data '{"label":"Background and timeline","color":"#9575d4"}' --format json

# Files inside Frame 1 (y = fy + FRAME_PAD = 50 + 24 = 74)
pulse-canvas node create --type file --title "Timeline" \
  --x 74 --y 74 --width 300 --height 360 \
  --data '{"content":"# Timeline\n\n..."}' --format json

pulse-canvas node create --type file --title "Key Figures" \
  --x 398 --y 74 --width 300 --height 360 \
  --data '{"content":"# Key Figures\n\n..."}' --format json

pulse-canvas node create --type file --title "Turning Points" \
  --x 722 --y 74 --width 300 --height 360 \
  --data '{"content":"# Turning Points\n\n..."}' --format json

# Frame 2: "Core Concepts" — 2 files (2 cols)
# Frame: x=1146, y=50, w=672, h=408
pulse-canvas node create --type frame --title "Core Concepts" \
  --x 1146 --y 50 --width 672 --height 408 \
  --data '{"label":"Fundamentals","color":"#4a90d9"}' --format json

# Files inside Frame 2
pulse-canvas node create --type file --title "Fundamentals" \
  --x 1170 --y 74 --width 300 --height 360 \
  --data '{"content":"# Fundamentals\n\n..."}' --format json

pulse-canvas node create --type file --title "Advanced Topics" \
  --x 1494 --y 74 --width 300 --height 360 \
  --data '{"content":"# Advanced Topics\n\n..."}' --format json

# Frame 3: "Current Landscape" — 3 files, Row 2
# Row 2 y = 50 + 408 + 100 = 558
# Frame: x=50, y=558, w=996, h=408
pulse-canvas node create --type frame --title "Current Landscape" \
  --x 50 --y 558 --width 996 --height 408 \
  --data '{"label":"Where things stand","color":"#4ad97a"}' --format json

# Files inside Frame 3 (y = 558 + 24 = 582)
pulse-canvas node create --type file --title "Key Players" \
  --x 74 --y 582 --width 300 --height 360 \
  --data '{"content":"# Key Players\n\n..."}' --format json

pulse-canvas node create --type file --title "Trends" \
  --x 398 --y 582 --width 300 --height 360 \
  --data '{"content":"# Trends\n\n..."}' --format json

pulse-canvas node create --type file --title "Challenges" \
  --x 722 --y 582 --width 300 --height 360 \
  --data '{"content":"# Challenges\n\n..."}' --format json

# Frame 4: "Action Plan" — 2 files, Row 2
# Frame: x=1146, y=558, w=672, h=408
pulse-canvas node create --type frame --title "Action Plan" \
  --x 1146 --y 558 --width 672 --height 408 \
  --data '{"label":"Next steps","color":"#d94a4a"}' --format json

pulse-canvas node create --type file --title "Short-term Tasks" \
  --x 1170 --y 582 --width 300 --height 360 \
  --data '{"content":"# Short-term Tasks\n\n- [ ] ..."}' --format json

pulse-canvas node create --type file --title "Long-term Goals" \
  --x 1494 --y 582 --width 300 --height 360 \
  --data '{"content":"# Long-term Goals\n\n..."}' --format json
```

### Phase 5: Verify and Summarize

```bash
pulse-canvas context --format json
```

Tell the user: what frames were created, what each contains, and key findings from your research.

## Frame Colors

| Purpose | Hex |
|---------|-----|
| Overview / Summary | `#5594e8` |
| Research / Analysis | `#9575d4` |
| Tasks / Actions | `#e8615a` |
| Implementation | `#3eb889` |
| Notes / Decisions | `#e89545` |
| Data / Metrics | `#35aec2` |

## Quality Rules

1. **Every frame has 2-4 file nodes** — if only 1, merge; if 5+, split
2. **Every file node has real content** — synthesized, not placeholder
3. **File nodes are inside their frame** — check coordinates match
4. **Research before creating** — no canvas without deep understanding first
5. **Content is actionable** — someone should be able to act on what they read
