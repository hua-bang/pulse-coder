---
name: twitter-reader
description: Analyze X/Twitter accounts, tweets, and trends through the installed Twitter MCP tools
version: 1.0.0
author: Pulse Coder Team
---

# Twitter Reader Skill

Use this skill when you want structured Twitter/X analysis using the `mcp_twitter_*` tools.

## Preconditions

- MCP server `twitter` is configured in `.pulse-coder/mcp.json`.
- Environment variable `TWITTER_TOKEN` is set in your runtime shell (or repo `.env`).

## Workflow

1. Clarify the objective in one line:
   - account profile
   - recent tweets
   - keyword search
   - follower changes
   - deleted tweets
2. Pick the smallest matching tool set first.
3. Return concise findings first, then supporting evidence.
4. If results are empty, broaden filters once before concluding.

## Tool Mapping

- Profile lookup: `mcp_twitter_get_twitter_user`
- User tweets: `mcp_twitter_get_twitter_user_tweets`
- Basic search: `mcp_twitter_search_twitter`
- Advanced search: `mcp_twitter_search_twitter_advanced`
- Follower events: `mcp_twitter_get_twitter_follower_events`
- Deleted tweets: `mcp_twitter_get_twitter_deleted_tweets`
- KOL followers: `mcp_twitter_get_twitter_kol_followers`

## Output Contract

- Start with 3-6 bullet findings.
- Include key stats (counts, top engagement, timestamps) when available.
- Add caveats if data is partial or near real-time lag.
- End with one practical next action.

## Example Requests

- "Analyze @elonmusk recent 50 tweets and highlight the top narratives."
- "Find ETH tweets with >1000 likes in the last 24h."
- "Check new followers and unfollowers for @VitalikButerin this week."
