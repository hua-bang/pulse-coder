# Experimental apps

The following apps are intentionally **excluded** from the default pnpm workspace to keep installs and CI lightweight:

- `apps/coder-demo`
- `apps/devtools-web`
- `apps/canvas-workspace`

They are kept in-repo for reference and ad-hoc experiments.

## Run an experimental app manually

Example:

```bash
cd apps/devtools-web
pnpm install
pnpm dev
```

For Electron app:

```bash
cd apps/canvas-workspace
pnpm install
pnpm dev
```
