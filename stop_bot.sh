#!/bin/bash
LABEL="com.cosmicai.telegram-bot"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
fi

pkill -f "start_bot.sh" >/dev/null 2>&1 || true
pkill -f "node telegram-bot-fixed-v2.js" >/dev/null 2>&1 || true
rm -f ".bot-monitor.pid"
echo "Bot stopped."
