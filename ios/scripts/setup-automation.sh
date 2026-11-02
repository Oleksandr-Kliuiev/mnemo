#!/bin/bash
# One-time setup of automatic renewal for the Mnemo iOS app on this Mac.
#   ios/scripts/setup-automation.sh [TEAM_ID]
# Creates ~/Library/Application Support/Mnemo (a clone of the project + settings + logs)
# and a LaunchAgent that checks every 3 hours and reinstalls the app 2 days before its
# free 7-day signature expires.
set -euo pipefail

HOME_DIR="$HOME/Library/Application Support/Mnemo"
REPO_URL="${REPO_URL:-https://github.com/Oleksandr-Kliuiev/mnemo.git}"
LABEL="com.oleksandrkliuiev.mnemo.renew"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

mkdir -p "$HOME_DIR/state" "$HOME/Library/LaunchAgents"

if [ ! -d "$HOME_DIR/repo/.git" ]; then
  echo "Клонирую проект в $HOME_DIR/repo…"
  git clone --quiet "$REPO_URL" "$HOME_DIR/repo"
else
  git -C "$HOME_DIR/repo" pull --ff-only --quiet || true
fi

TEAM_ID="${1:-}"
if [ -z "$TEAM_ID" ]; then
  # The Personal Team of the Apple ID added in Xcode → Settings → Accounts.
  TEAM_ID="$(defaults export com.apple.dt.Xcode - 2>/dev/null | /usr/bin/python3 -c '
import plistlib, sys
try:
    d = plistlib.loads(sys.stdin.buffer.read())
except Exception:
    sys.exit(0)
teams = [t for ts in d.get("IDEProvisioningTeamByIdentifier", {}).values() for t in ts]
teams.sort(key=lambda t: not t.get("isFreeProvisioningTeam", False))
print(teams[0]["teamID"] if teams else "")
')"
fi
if [ -z "$TEAM_ID" ]; then
  echo "Не нашёл команду разработчика. Добавьте Apple ID: Xcode → Settings → Accounts → «+», и запустите снова." >&2
  exit 1
fi

NODE_DIR="$(dirname "$(command -v node)")"
cat >"$HOME_DIR/config.env" <<CFG
# Mnemo iOS automation settings
TEAM_ID="$TEAM_ID"
BUNDLE_ID="com.oleksandrkliuiev.mnemo"
# Leave empty to use any paired iPhone, or set its name / UDID.
DEVICE=""
BACKUP_DIR="$HOME/Documents/Mnemo Backups"
# 1 = take the latest version from GitHub before every renewal.
AUTO_UPDATE=1
RENEW_BEFORE_HOURS=48
NODE_DIR="$NODE_DIR"
CFG

cat >"$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$HOME_DIR/repo/ios/scripts/mnemo-ios.sh</string>
    <string>auto</string>
  </array>
  <key>StartInterval</key>
  <integer>10800</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$HOME_DIR/state/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME_DIR/state/launchd.log</string>
</dict>
</plist>
PL

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Готово: проверка каждые 3 часа, продление за 2 дня до истечения подписи."
echo "Команда разработчика: $TEAM_ID"
echo "Статус:  \"$HOME_DIR/repo/ios/scripts/mnemo-ios.sh\" status"
