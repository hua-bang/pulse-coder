#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${REMOTE_SERVER_BASE_URL:-http://127.0.0.1:3000}"
SECRET="${INTERNAL_API_SECRET:-}"

if [[ -z "$SECRET" ]]; then
  echo "INTERNAL_API_SECRET is required" >&2
  exit 2
fi

STATE_DIR="${DISCORD_GATEWAY_WATCHDOG_STATE_DIR:-.cron-locks}"
STATE_FILE="$STATE_DIR/discord-gateway-watchdog.state"
FAIL_THRESHOLD="${DISCORD_GATEWAY_FAIL_THRESHOLD:-2}"
COOLDOWN_SEC="${DISCORD_GATEWAY_RESTART_COOLDOWN_SEC:-300}"
MAX_ESCALATIONS="${DISCORD_GATEWAY_MAX_ESCALATIONS:-3}"
RESTART_COMMAND="${DISCORD_GATEWAY_ESCALATION_RESTART_COMMAND:-npm run pm2:restart}"

mkdir -p "$STATE_DIR"

fail_count=0
last_restart_ts=0
escalation_count=0
if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE"
fi

save_state() {
  cat >"$STATE_FILE" <<EOF
fail_count=$fail_count
last_restart_ts=$last_restart_ts
escalation_count=$escalation_count
EOF
}

now_ts=$(date +%s)
status_json=$(curl -fsS \
  -H "Authorization: Bearer $SECRET" \
  "$BASE_URL/internal/discord/gateway/status")

healthy=$(printf '%s' "$status_json" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);process.stdout.write(j.ok && j.gateway && j.gateway.healthy ? 'true' : 'false');});")

if [[ "$healthy" == "true" ]]; then
  fail_count=0
  escalation_count=0
  save_state
  exit 0
fi

fail_count=$((fail_count + 1))
if (( fail_count < FAIL_THRESHOLD )); then
  save_state
  exit 0
fi

if (( now_ts - last_restart_ts < COOLDOWN_SEC )); then
  save_state
  exit 0
fi

curl -fsS -X POST \
  -H "Authorization: Bearer $SECRET" \
  "$BASE_URL/internal/discord/gateway/restart" >/dev/null

last_restart_ts=$now_ts
fail_count=0
escalation_count=$((escalation_count + 1))

if (( escalation_count >= MAX_ESCALATIONS )); then
  sh -c "$RESTART_COMMAND" >/dev/null 2>&1 || true
  escalation_count=0
fi

save_state
