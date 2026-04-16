#!/usr/bin/env bash
# Quick demo: simulate canvas-bootstrap with nodes + edges
set -euo pipefail

echo "=== 1. Create workspace ==="
WS_JSON=$(pulse-canvas workspace create "Demo Research" --format json)
WS_ID=$(echo "$WS_JSON" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).id)")
echo "Workspace: $WS_ID"
export PULSE_CANVAS_WORKSPACE_ID="$WS_ID"

echo ""
echo "=== 2. Create frames ==="

F1=$(pulse-canvas node create --type frame --title "Background" \
  --x 50 --y 50 --width 672 --height 408 \
  --data '{"label":"Historical context","color":"#9575d4"}' --format json)
F1_ID=$(echo "$F1" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).nodeId)")
echo "Frame 1: $F1_ID"

F2=$(pulse-canvas node create --type frame --title "Core Concepts" \
  --x 822 --y 50 --width 672 --height 408 \
  --data '{"label":"Key ideas","color":"#4a90d9"}' --format json)
F2_ID=$(echo "$F2" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).nodeId)")
echo "Frame 2: $F2_ID"

F3=$(pulse-canvas node create --type frame --title "Action Plan" \
  --x 50 --y 558 --width 672 --height 408 \
  --data '{"label":"Next steps","color":"#e8615a"}' --format json)
F3_ID=$(echo "$F3" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).nodeId)")
echo "Frame 3: $F3_ID"

echo ""
echo "=== 3. Create file nodes inside frames ==="

pulse-canvas node create --type file --title "Timeline" \
  --x 74 --y 74 --width 300 --height 360 \
  --data '{"content":"# Timeline\n\n- 2020: Project started\n- 2023: v1.0 released\n- 2025: Current state"}' \
  --format json > /dev/null
echo "  Timeline (in Background)"

pulse-canvas node create --type file --title "Key Players" \
  --x 398 --y 74 --width 300 --height 360 \
  --data '{"content":"# Key Players\n\n- **Alice** — founder\n- **Bob** — lead engineer\n- **Carol** — community"}' \
  --format json > /dev/null
echo "  Key Players (in Background)"

pulse-canvas node create --type file --title "Fundamentals" \
  --x 846 --y 74 --width 300 --height 360 \
  --data '{"content":"# Fundamentals\n\n## Core Principles\n1. Simplicity first\n2. Extensibility\n3. Performance"}' \
  --format json > /dev/null
echo "  Fundamentals (in Core Concepts)"

pulse-canvas node create --type file --title "Advanced Topics" \
  --x 1170 --y 74 --width 300 --height 360 \
  --data '{"content":"# Advanced Topics\n\n## Plugin Architecture\n\nPlugins extend the core via hooks and tools."}' \
  --format json > /dev/null
echo "  Advanced Topics (in Core Concepts)"

pulse-canvas node create --type file --title "Short-term Tasks" \
  --x 74 --y 582 --width 300 --height 360 \
  --data '{"content":"# Short-term Tasks\n\n- [ ] Fix edge rendering\n- [ ] Add tests\n- [ ] Update docs"}' \
  --format json > /dev/null
echo "  Short-term Tasks (in Action Plan)"

pulse-canvas node create --type file --title "Long-term Goals" \
  --x 398 --y 582 --width 300 --height 360 \
  --data '{"content":"# Long-term Goals\n\n- [ ] Multi-user collaboration\n- [ ] Cloud sync\n- [ ] Mobile app"}' \
  --format json > /dev/null
echo "  Long-term Goals (in Action Plan)"

echo ""
echo "=== 4. Create edges (connections) ==="

E1=$(pulse-canvas edge create --from "$F1_ID" --to "$F2_ID" \
  --label "established" --kind flow \
  --color "#9575d4" --format json)
E1_ID=$(echo "$E1" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).edgeId)")
echo "  Edge: Background → Core Concepts  ($E1_ID)"

E2=$(pulse-canvas edge create --from "$F2_ID" --to "$F3_ID" \
  --label "informs" --kind dependency \
  --color "#4a90d9" --style dashed --format json)
E2_ID=$(echo "$E2" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).edgeId)")
echo "  Edge: Core Concepts → Action Plan  ($E2_ID)"

E3=$(pulse-canvas edge create --from "$F1_ID" --to "$F3_ID" \
  --label "motivates" --kind reference \
  --color "#e8615a" --style dotted --bend 80 --format json)
E3_ID=$(echo "$E3" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).edgeId)")
echo "  Edge: Background → Action Plan  ($E3_ID)"

echo ""
echo "=== 5. Verify: context output ==="
pulse-canvas context --format json | node -e "
  const ctx = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log('Workspace:', ctx.workspaceName);
  console.log('Nodes:', ctx.nodes.length);
  console.log('Edges:', ctx.edges.length);
  console.log('');
  ctx.edges.forEach(e => console.log('  ' + e.source + ' → ' + e.target + (e.label ? ' \"' + e.label + '\"' : '') + (e.kind ? ' [' + e.kind + ']' : '')));
"

echo ""
echo "=== Done! ==="
echo "Open canvas-workspace and select workspace '$WS_ID' to see nodes + edges."
echo "Or run:  pulse-canvas context -w $WS_ID"
