---
name: copilot-api-setup
description: 一键把 GitHub Copilot 变成本地 Anthropic-compatible 代理，让 Claude Code 免 API Key 使用。触发词：配置 copilot-api / 帮我配 Claude Code / 本地代理怎么装 / setup copilot-api / copilot proxy。
version: 1.1.0
author: Jasper Hu
---

# copilot-api-setup

把 GitHub Copilot 变成 Anthropic-compatible 代理，让本地 Claude Code 免 API Key 使用。

**只需要 node >= 18，无需其他工具。**

## 触发条件

用户说以下任意内容时使用此 skill：
- "帮我配一下 Claude Code"
- "配置 copilot-api"
- "我想用 copilot 跑 claude code"
- "本地代理怎么装"
- "setup copilot-api"
- "copilot proxy"

---

## 执行步骤

### Step 1 — 检查代理是否已在运行

```bash
curl -sf --max-time 2 "http://localhost:4141/models" > /dev/null 2>&1 && echo "RUNNING" || echo "NOT_RUNNING"
```

`RUNNING` → 直接跳到 **Step 7** 输出配置。

---

### Step 2 — 检查 node

```bash
node --version 2>/dev/null || echo "NO_NODE"
```

`NO_NODE` → 告知用户安装 https://nodejs.org，安装后继续。

---

### Step 3 — 下载并解压（如未安装）

```bash
test -f "$HOME/.copilot-api-local/dist/main.js" && echo "INSTALLED" || echo "NOT_INSTALLED"
```

如果 `NOT_INSTALLED`：

```bash
mkdir -p "$HOME/.copilot-api-local"
curl -L http://jasperhu.art/apps/copilot-api-v4.zip -o /tmp/copilot-api.zip
unzip -o /tmp/copilot-api.zip -d "$HOME/.copilot-api-local/"
rm /tmp/copilot-api.zip
echo "done"
```

---

### Step 4 — 安装依赖

```bash
cd "$HOME/.copilot-api-local" && npm install --omit=dev 2>&1 | tail -3
```

---

### Step 5 — 检查 GitHub Token

```bash
TOKEN_PATH="$HOME/.local/share/copilot-api/github_token"
test -s "$TOKEN_PATH" && echo "TOKEN_OK" || echo "NO_TOKEN"
```

**TOKEN_OK** → 跳到 Step 6。

**NO_TOKEN** → 告知用户：

> 需要先完成一次 GitHub 授权（之后永久有效）。
> 请**新开一个终端**，运行：
> ```bash
> cd ~/.copilot-api-local
> node dist/main.js auth
> ```
> 按照提示访问链接、输入验证码，完成后回来告诉我。

等用户说"好了"/"done"/"完成"后，再次执行 Step 5 的检查命令确认 token 已写入，然后继续。

---

### Step 6 — 启动代理

```bash
INSTALL_DIR="$HOME/.copilot-api-local"
TOKEN_PATH="$HOME/.local/share/copilot-api/github_token"
PORT=4141

# 清理旧进程
[ -f "$INSTALL_DIR/proxy.pid" ] && kill "$(cat "$INSTALL_DIR/proxy.pid")" 2>/dev/null || true

cd "$INSTALL_DIR"
nohup node dist/main.js start \
  --port "$PORT" \
  --github-token "$(cat "$TOKEN_PATH")" \
  > "$INSTALL_DIR/proxy.log" 2>&1 &
echo $! > "$INSTALL_DIR/proxy.pid"
echo "started"
```

等待启动：

```bash
for i in 1 2 3 4 5; do
  sleep 2
  curl -sf --max-time 3 "http://localhost:4141/models" > /dev/null 2>&1 && echo "OK" && break
  echo "waiting $i..."
done
```

---

### Step 7 — 输出配置

✅ **copilot-api 代理已运行在 `http://localhost:4141`**

告知用户：

---

代理已启动，请自行将以下两行加入 `~/.zshrc` 或 `~/.bashrc`，然后 `source` 一下：

```bash
export ANTHROPIC_BASE_URL=http://localhost:4141
export ANTHROPIC_API_KEY=copilot-proxy
```

加完之后直接运行 `claude` 即可。

如果暂时不想改 shell 配置，也可以每次这样启动：

```bash
ANTHROPIC_BASE_URL=http://localhost:4141 ANTHROPIC_API_KEY=copilot-proxy claude
```

**代理管理：**
```bash
tail -f ~/.copilot-api-local/proxy.log          # 查看日志
kill $(cat ~/.copilot-api-local/proxy.pid)       # 停止
bash ~/.copilot-api-local/setup.sh              # 重启（机器重启后）
bash ~/.copilot-api-local/setup.sh --reinstall  # 强制重装
```

---

不要替用户执行 `echo export >> ~/.zshrc` 之类的操作，让用户自己决定写入时机。
