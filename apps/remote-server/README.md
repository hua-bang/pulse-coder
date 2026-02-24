# remote-server

## Enabled webhook endpoints

- `POST /webhooks/feishu`
- `POST /webhooks/discord`

> Telegram and Web API adapters exist in code but are currently not mounted by default.

## Discord setup (hybrid mode)

Hybrid mode behavior:

- Guild/channel chats use **slash commands** via interactions webhook (`/ask`, `/new`, `/status`, etc.).
- DM chats support **direct text messages** (no `/ask` required) via Discord Gateway listener.

### 1) Configure app settings in Discord Developer Portal

1. Copy the **Public Key** from your application settings.
2. Configure **Interactions Endpoint URL**:

```text
https://your-server-domain/webhooks/discord
```

3. In **Bot** settings, enable intents:
   - `Direct Messages`
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

### 3) Register slash commands (recommended)

- `/ask <text>` for prompts in guild channels.
- Optional pass-through commands: `/help`, `/new`, `/compact`, `/resume`, `/status`, etc.

### 4) DM usage

- DM message text is forwarded directly to the agent.
- `/ask foo`, `/chat foo`, `/prompt foo` in DM are normalized to `foo` for compatibility.
- Group/guild plain text is ignored; keep using slash commands there.

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
