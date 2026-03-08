---
name: twitter-list-fetcher
description: Fetch latest tweets from an X/Twitter list with the built-in twitter_list_tweets tool, then summarize key updates.

user-invocable: true
metadata:
  version: 1.0.0
---

# X List Fetcher Skill

Use this skill when the user asks to:
- Read latest tweets from an X list URL
- Track list updates and produce a short summary
- Extract tweet text + links for further analysis

## Tool Used

This skill uses the deferred tool:
- `twitter_list_tweets`

## Input

Required:
- `listUrl`: X list URL (for example `https://x.com/i/lists/1234567890`)

Optional:
- `limit`: max tweets to return, `1-100` (default `20`)
- `nitterInstance`: preferred Nitter-compatible instance, for example `https://nitter.net`
- `timeoutMs`: request timeout in milliseconds (default `20000`)

## Recommended Flow

1. Validate `listUrl`.
2. Call `twitter_list_tweets` with `listUrl` and optional params.
3. If `ok=false`, report `error` and `meta.attemptedInstances`.
4. If `ok=true`, summarize:
   - main themes/trends
   - notable tweets (with `url`)
   - retweet/reply ratio signals (`isRetweet`, `isReply`)
5. Keep summary concise unless user requests deep analysis.

## Output Schema (from tool)

- `ok`: boolean
- `listId`: parsed numeric list id
- `sourceListUrl`: normalized list URL
- `rssUrl`: RSS endpoint used
- `instanceUsed`: chosen Nitter-compatible instance
- `fetchedAt`: ISO timestamp
- `tweets[]`:
  - `id`, `url`, `text`, `publishedAt`, `authorHandle`, `authorName`, `isRetweet`, `isReply`
- `meta`:
  - `requestedLimit`, `returnedCount`, `deduplicatedCount`, `truncated`, `attemptedInstances`
- `error`: failure reason when `ok=false`
