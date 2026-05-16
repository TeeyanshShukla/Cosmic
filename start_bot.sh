#!/bin/bash

cd "$(dirname "$0")"

MONITOR_LOG="bot-monitor.log"
BOT_LOG="bot.log"
BOT_CMD=(node telegram-bot-fixed-v2.js)
LOCK_FILE=".bot-monitor.pid"
BOT_PID=""

log() {
  echo "[$(date)] $*" >> "$MONITOR_LOG"
}

cleanup() {
  if [[ -n "$BOT_PID" ]] && kill -0 "$BOT_PID" 2>/dev/null; then
    kill "$BOT_PID" 2>/dev/null || true
  fi
  rm -f "$LOCK_FILE"
}

if [[ -f "$LOCK_FILE" ]]; then
  old_pid="$(cat "$LOCK_FILE" 2>/dev/null)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    log "Monitor already running with PID $old_pid"
    exit 0
  fi
fi

echo $$ > "$LOCK_FILE"
trap cleanup EXIT INT TERM

log "=== Bot Monitor Started ==="

while true; do
  if pgrep -f "node telegram-bot-fixed-v2.js" >/dev/null; then
    sleep 5
    continue
  fi

  log "Starting Telegram Bot..."
  "${BOT_CMD[@]}" >> "$BOT_LOG" 2>&1 &
  BOT_PID=$!
  log "Bot started with PID $BOT_PID"
  wait "$BOT_PID"
  exit_code=$?
  log "Bot exited with code $exit_code; restarting in 2s"
  BOT_PID=""
  sleep 2

done
