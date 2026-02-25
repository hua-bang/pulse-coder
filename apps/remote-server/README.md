# remote-server

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
