---
name: find-skills
description: Discover and install skills from the open agent skills ecosystem
version: 1.0.0
author: vercel-labs (adapted for Pulse Coder)
---

# Find Skills

This skill helps discover and install skills for common tasks.

## When to Use

Use this skill when the user:
- Asks how to do a task that may already have a community skill
- Asks to find a skill for a domain (testing, deployment, UI, docs, etc.)
- Asks for specialized capability extensions
- Wants templates, workflows, or reusable automation

## Skills CLI Overview

The Skills CLI is commonly used as a package manager for open agent skills.

Common commands:
- `npx skills find [query]` - search skills by keyword
- `npx skills add <owner/repo@skill>` - install a specific skill
- `npx skills check` - check for updates
- `npx skills update` - update installed skills

## Workflow

### 1) Clarify the need
Identify:
1. Domain (react, testing, design, deployment, docs, etc.)
2. Specific outcome (optimize, review PR, generate changelog, etc.)
3. Whether a reusable skill is likely available

### 2) Search
Use a specific query:
- `npx skills find react performance`
- `npx skills find pr review`
- `npx skills find changelog`

### 3) Present options
When results are found, provide:
1. Skill name
2. What it does
3. Install command
4. Marketplace/reference link (for example `https://skills.sh`)

### 4) Install on request
Install with:
- `npx skills add <owner/repo@skill>`

If your runtime expects Pulse Coder local skills, place skill files under:
- Project scope: `.pulse-coder/skills/<skill-name>/SKILL.md`
- User scope: `~/.pulse-coder/skills/<skill-name>/SKILL.md`

## Search Tips

- Prefer specific multi-word queries over single generic terms
- Try alternate terms when needed (`deploy` -> `deployment` / `ci-cd`)
- Check popular publishers and curated registries

## If No Skill Is Found

- State that no suitable skill was found
- Offer to handle the task directly
- Optionally offer to scaffold a new local skill
