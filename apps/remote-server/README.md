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

## PTC allowed_callers demo

`allowed_callers` in this repo is implemented as a caller tool-name allowlist.

- `ptc_demo_caller_probe`: unrestricted probe tool
- `ptc_demo_caller_only`: `allowed_callers=["ptc_demo_caller_probe"]`
- `ptc_demo_cron_only`: `allowed_callers=["cron_job"]`
- `ptc_demo_deferred_only`: `allowed_callers=["deferred_demo"]`

Quick test via internal endpoint:

```bash
curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $INTERNAL_API_SECRET" \
  http://127.0.0.1:3000/internal/agent/run \
  -d '{
    "text": "Call ptc_demo_caller_only with message=hello",
    "caller": "ptc_demo_caller_probe",
    "callerSelectors": ["ptc_demo_caller_probe"]
  }'
```

If you use a non-matching caller (or omit it), restricted demo tools should be filtered out by PTC rules.

## Enabled webhook endpoints

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
# DISCORD_COMMAND_REGISTER_ENABLED=true
# DISCORD_COMMAND_GUILD_IDS=123456789012345678,987654321098765432
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
- Optional pass-through commands: `/help`, `/new`, `/compact`, `/resume`, `/status`, `/restart`, `/soul`, etc.
- `/restart` is auto-registered on startup when `DISCORD_COMMAND_REGISTER_ENABLED=true`.
- Slash option mapping: `mode=status` -> `/restart status`, `mode=update branch=<name>` -> `/restart update <name>`.
- For faster propagation during development, set `DISCORD_COMMAND_GUILD_IDS`; global registration may take up to ~1 hour.

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
