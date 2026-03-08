# remote-server

## Built-in X list tool

A deferred tool named `twitter_list_tweets` is available for fetching tweets from X lists.

Quick test (local-only internal endpoint):

```bash
curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $INTERNAL_API_SECRET" \
  http://127.0.0.1:3000/internal/agent/run \
  -d '{"text":"Use tool_search_tool_bm25 to find twitter_list_tweets, then call it with listUrl=https://x.com/i/lists/1234567890 and limit=10."}'
```

Tool behavior:
- Uses Nitter-compatible RSS (`/i/lists/<id>/rss`) with fallback instances.
- Returns normalized tweet records with dedupe metadata.
- If all instances fail, returns `ok=false` with attempted instances and error details.

## Deferred tool demo

A demo tool named `deferred_demo` is registered with `defer_loading: true`.
It will not be sent to the AI SDK until it is discovered via tool search.

Quick test (local-only internal endpoint):

```bash
curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $INTERNAL_API_SECRET" \
  http://127.0.0.1:3000/internal/agent/run \
  -d '{"text":"Use tool_search_tool_bm25 to find the deferred_demo tool, then call it with message=hello."}'
```

Expected behavior:
- First run: model uses tool search and discovers `deferred_demo`.
- Second run: `deferred_demo` is now loaded and can be called directly.

## PTC demo tools

`remote-server` now includes several demo tools to validate PTC filtering by caller selectors.

Registered demo tools:
- `ptc_demo_caller_probe` (no restrictions)
- `ptc_demo_discord_only` (`allowed_callers: ["platform:discord"]`)
- `ptc_demo_feishu_only` (`allowed_callers: ["platform:feishu"]`)
- `ptc_demo_internal_only` (`allowed_callers: ["platform:internal"]`)
- `ptc_demo_group_only` (`allowed_callers: ["kind:group", "kind:channel"]`)

How selectors are produced in remote-server:
- `runContext.callerSelectors` always includes `platform_key:<platformKey-lowercase>`
- plus platform selector like `platform:discord` / `platform:feishu` / `platform:internal`
- plus kind selector like `kind:dm` / `kind:channel` / `kind:group`
- plus `thread:true|false` for Discord thread/channel cases

Quick internal API checks:

```bash
# internal caller: should allow internal_only, block discord_only/feishu_only
curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $INTERNAL_API_SECRET" \
  http://127.0.0.1:3000/internal/agent/run \
  -d '{"platformKey":"internal:ptc-demo","text":"Call ptc_demo_internal_only with message=ok, then call ptc_demo_discord_only."}'
```

```bash
# discord channel caller: should allow discord_only and group_only
curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $INTERNAL_API_SECRET" \
  http://127.0.0.1:3000/internal/agent/run \
  -d '{"platformKey":"discord:channel:123456:789","text":"Call ptc_demo_discord_only and ptc_demo_group_only with message=ok."}'
```

```bash
# feishu dm caller: should allow feishu_only, block group_only
curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $INTERNAL_API_SECRET" \
  http://127.0.0.1:3000/internal/agent/run \
  -d '{"platformKey":"feishu:ou_xxx","text":"Call ptc_demo_feishu_only and then ptc_demo_group_only."}'
```


- `POST /webhooks/feishu`
- `POST /webhooks/discord`

> Telegram and Web API adapters exist in code but are currently not mounted by default.

## Discord setup (gateway-friendly)

Gateway mode behavior:

- Guild/channel chats support **@mention direct text** via Discord Gateway listener.
- Guild/channel slash commands via interactions webhook still work if you have an HTTPS endpoint.
- DM chats support **direct text messages** (no `/ask` required) via Discord Gateway listener.

### 1) Configure app settings in Discord Developer Portal

1. Copy the **Public Key** from your application settings.
2. Optional (only when you have HTTPS): configure **Interactions Endpoint URL**:

```text
https://your-server-domain/webhooks/discord
```

3. In **Bot** settings, enable intents:
   - `Direct Messages`
   - `Server Messages`
   - `Message Content Intent`

### 2) Set environment variables

```bash
DISCORD_PUBLIC_KEY=your_discord_public_key
DISCORD_BOT_TOKEN=your_discord_bot_token

# Optional overrides:
# DISCORD_API_BASE_URL=https://discord.com/api/v10
# DISCORD_GATEWAY_URL=wss://gateway.discord.gg/?v=10&encoding=json
# DISCORD_PROXY_URL=http://127.0.0.1:7890
# DISCORD_DM_GATEWAY_ENABLED=true
```

### 3) Guild usage (no HTTPS required)

- Default behavior: mention the bot in a guild channel, then type your prompt.
- Example: `@YourBot explain this stack trace`
- To allow plain text without mention in guild channels, set:

```bash
DISCORD_GUILD_REQUIRE_MENTION=false
```

### 4) Slash commands (optional, requires HTTPS interactions endpoint)

- `/ask <text>` for prompts in guild channels.
- Optional pass-through commands: `/help`, `/new`, `/compact`, `/resume`, `/status`, etc.

### 5) DM usage

- DM message text is forwarded directly to the agent.
- `/ask foo`, `/chat foo`, `/prompt foo` in DM are normalized to `foo` for compatibility.

### 6) Discord gateway internal ops (local only)

The server now exposes local-only, auth-protected internal endpoints to inspect/restart Discord gateway without restarting the whole process.

```bash
# status
curl -sS \
  -H "Authorization: Bearer $INTERNAL_API_SECRET" \
  http://127.0.0.1:3000/internal/discord/gateway/status

# restart only discord gateway
curl -sS -X POST \
  -H "Authorization: Bearer $INTERNAL_API_SECRET" \
  http://127.0.0.1:3000/internal/discord/gateway/restart
```

For watchdog checks, poll every ~90s and trigger restart only after consecutive unhealthy checks.

## PM2 deployment (recommended)

Use PM2 instead of `setsid ... &` for long-running server processes.

### 1) Install PM2

```bash
npm i -g pm2
```

### 2) Start service (build + run)

```bash
npm run pm2:start
```

### 3) Daily operations

```bash
npm run pm2:logs      # view logs
npm run pm2:restart   # rebuild + restart
npm run pm2:stop      # stop process
npm run pm2:delete    # remove process from pm2
npm run pm2:save      # persist process list
```

### 4) Enable startup on reboot

```bash
pm2 startup
pm2 save
```

> `ecosystem.config.cjs` is configured to run `dist/index.cjs` in fork mode with autorestart and memory guard.
