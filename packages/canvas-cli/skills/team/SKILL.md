---
name: team
description: Coordinate as part of an agent team — claim tasks, send messages, report completion
version: 1.0.0
---

# Pulse Canvas — Agent Team Coordination

You are working as part of an agent team on a shared canvas. Multiple agents (yourself included) coordinate through file-backed task lists and mailboxes managed by `pulse-canvas team` subcommands.

## Your team identity (always set before starting)

If you were spawned as a team member, your initial prompt told you your team identity. Confirm it:

```
$PULSE_TEAM_ID      → the team UUID
$PULSE_TEAM_MEMBER  → your member id (e.g. "abc123-m2")
$PULSE_TEAM_ROLE    → "lead" or "teammate"
```

If any are missing, you are NOT a team member yet — STOP and ask the user how you should fit into the team. Do not invent member ids.

## Core protocol

Every team has two persistent stores under `~/.pulse-coder/teams/{teamId}/`:

| Store | What | Who reads | Who writes |
|-------|------|-----------|-----------|
| `tasks/tasks.json` | Shared task list (with deps, status, assignee) | All members | All members (file-locked) |
| `mailbox/{memberId}.json` | Per-member inbox | The owning member | Anyone in the team |

**Always operate via the CLI, never edit these JSON files directly** — the CLI applies file locks and validates membership; raw edits will corrupt state and may be rejected by other members' next read.

## Commands

### See team state
```bash
pulse-canvas team status $PULSE_TEAM_ID
```
Shows members, lead, and task statistics. Use this as a heartbeat.

### Read your inbox (do this every loop iteration)
```bash
pulse-canvas team msg read $PULSE_TEAM_ID --member-id $PULSE_TEAM_MEMBER --format json
```
Returns unread messages and marks them read. Empty result means nothing new.

### Send a message to a teammate
```bash
pulse-canvas team msg send $PULSE_TEAM_ID \
  --from $PULSE_TEAM_MEMBER \
  --to <other-member-id> \
  --content "T2 done — output at notes/drizzle.md"
```
Use `--to "*"` to broadcast to everyone in the team.

### List tasks
```bash
pulse-canvas team task list $PULSE_TEAM_ID --status pending --format json
```

### Claim a task (auto-pick or specific)
```bash
# Auto-claim: priority is pre-assigned-to-me → unassigned → work-stealing
pulse-canvas team task claim $PULSE_TEAM_ID --member-id $PULSE_TEAM_MEMBER --format json

# Or claim a specific task
pulse-canvas team task claim $PULSE_TEAM_ID --member-id $PULSE_TEAM_MEMBER --task-id <id>
```
Returns `null` if nothing claimable. Tasks blocked by uncompleted deps are not returned.

### Mark a task complete
```bash
pulse-canvas team task complete $PULSE_TEAM_ID \
  --task-id <id> \
  --result "Drizzle wins — see notes/drizzle.md"
```
This unblocks any tasks that depend on yours.

### Lead-only: create tasks
```bash
pulse-canvas team task create $PULSE_TEAM_ID \
  --member-id $PULSE_TEAM_MEMBER \
  --title "Investigate Drizzle ORM" \
  --description "Read docs, build a 50-line POC, write findings to notes/drizzle.md" \
  --assignee <teammate-member-id> \
  --deps task-id-a,task-id-b
```
Pre-assign with `--assignee` or leave unassigned to let teammates auto-claim. Use `--deps` for ordering (e.g. "synthesis depends on the three research tasks").

## Workflow — if you are a TEAMMATE

```
loop:
  1. msg read           → handle any incoming messages first
  2. task claim         → grab next available task
     - if null and "all tasks completed", broadcast "I'm done" and exit
     - if null but tasks still in_progress, sleep 5s and retry (others working)
  3. do the work        → use file tools (read, edit, bash) to actually do it
  4. task complete      → mark done with a short result string
  5. msg send to lead   → "T<x> done"
  6. goto 1
```

## Workflow — if you are the LEAD

```
loop:
  1. team status        → look at the dashboard
  2. msg read           → handle teammate progress reports / questions
  3. decide:
     - new task should be created? → task create
     - task waiting on a teammate? → continue
     - all tasks completed? → synthesize results, broadcast shutdown_request, exit
  4. sleep 5s, goto 1
```

DO NOT do the teammates' work yourself, even if you could. Your job is to coordinate. If a teammate is stuck, message them or reassign the task.

## Coordination guidelines

- **One submission per command.** The CLI is non-interactive — each invocation is one atomic action. Don't try to chain via shell pipes.
- **Status drives behavior.** `task list --status in_progress` tells you what others are working on. Respect their assignments unless they're clearly stuck.
- **Use the mailbox, not the canvas chat.** Other team members can't see canvas chat messages — only mailbox messages.
- **Keep results small.** The `--result` field on task complete should be 1-2 sentences pointing at the actual output (file path, summary line). Long output goes in files.
- **Never edit `~/.pulse-coder/teams/` files directly.** Always use the CLI — it handles concurrency.
- **If a CLI command exits non-zero, READ THE ERROR.** Common ones: invalid member id (you mistyped), team not found (wrong teamId), task not in_progress (someone else completed it first — that's fine, move on).

## Coordination anti-patterns

- ❌ Polling `task list` every 100ms in a tight loop (waste of cycles, sleep 5s minimum)
- ❌ Claiming tasks you can't actually do "to be helpful" (leave them for the right specialist)
- ❌ Sending broadcast messages with status updates ("I'm starting T1!") — the task list already shows that
- ❌ Acting on stale information — always re-read `team status` before making coordination decisions
- ❌ Ignoring `shutdown_request` mailbox messages — when the lead sends one, finish the current step and exit

## Quick example (teammate doing one task)

```bash
# Wake up, check inbox
pulse-canvas team msg read $PULSE_TEAM_ID --member-id $PULSE_TEAM_MEMBER --format json

# Claim something to work on
pulse-canvas team task claim $PULSE_TEAM_ID --member-id $PULSE_TEAM_MEMBER --format json
# → got task abc-123: "Investigate Drizzle ORM"

# Do the actual work (use read/edit/bash here)
echo "Drizzle is type-safe but ..." > notes/drizzle.md

# Report completion
pulse-canvas team task complete $PULSE_TEAM_ID --task-id abc-123 \
  --result "Findings in notes/drizzle.md — type-safe, fast, smaller community"

# Notify the lead
pulse-canvas team msg send $PULSE_TEAM_ID \
  --from $PULSE_TEAM_MEMBER --to $PULSE_TEAM_LEAD \
  --content "T abc-123 done. notes/drizzle.md"
```
