#!/bin/bash
# Turns off automatic renewal (the app and its data on the iPhone stay as they are).
set -uo pipefail
LABEL="com.oleksandrkliuiev.mnemo.renew"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Автопродление выключено. Папка с копиями и журналом осталась: $HOME/Library/Application Support/Mnemo"
