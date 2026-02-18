# remote-server

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
