#!/bin/bash
# Mnemo for iOS: build, sign with a free Apple ID, back up the app's data and (re)install it.
#
#   mnemo-ios.sh install   build and install now (backs up the phone's data first)
#   mnemo-ios.sh auto      what the scheduler runs: reinstall only when the signature expires within 2 days
#   mnemo-ios.sh backup    copy the app's backups from the iPhone to the Mac
#   mnemo-ios.sh status    show device, signature expiry and the last runs
#
# Reinstalling over the existing app keeps all its data (cards live inside the app's container),
# so a free 7-day signature is renewed without losing anything.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOME_DIR="${MNEMO_HOME:-$HOME/Library/Application Support/Mnemo}"
CONFIG="$HOME_DIR/config.env"
STATE="$HOME_DIR/state"
LOG="$STATE/mnemo-ios.log"
mkdir -p "$STATE"

# shellcheck disable=SC1090
[ -f "$CONFIG" ] && source "$CONFIG"
BUNDLE_ID="${BUNDLE_ID:-com.oleksandrkliuiev.mnemo}"
TEAM_ID="${TEAM_ID:-}"
DEVICE="${DEVICE:-}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/Documents/Mnemo Backups}"
AUTO_UPDATE="${AUTO_UPDATE:-1}"
RENEW_BEFORE_HOURS="${RENEW_BEFORE_HOURS:-48}"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
export PATH="${NODE_DIR:+$NODE_DIR:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

DERIVED="$HOME_DIR/build"
APP_PATH="$DERIVED/Build/Products/Release-iphoneos/App.app"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG" >&2; }

notify() {
  /usr/bin/osascript -e "display notification \"$2\" with title \"Mnemo\" subtitle \"$1\"" >/dev/null 2>&1 || true
}

fail() {
  log "ОШИБКА: $*"
  notify "Не удалось продлить приложение" "$*"
  exit 1
}

trim_log() {
  if [ -f "$LOG" ] && [ "$(wc -l <"$LOG")" -gt 3000 ]; then
    tail -n 2000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
}

lock() {
  if ! mkdir "$STATE/lock" 2>/dev/null; then
    # A stale lock older than 2 hours is from a crashed run.
    if [ -n "$(find "$STATE/lock" -maxdepth 0 -mmin +120 2>/dev/null)" ]; then
      rm -rf "$STATE/lock" && mkdir "$STATE/lock"
    else
      log "Уже выполняется другой запуск, выхожу"
      exit 0
    fi
  fi
  trap 'rm -rf "$STATE/lock"' EXIT
}

# ── Device ───────────────────────────────────────────────────────────────────

# Prints "<identifier>\t<name>\t<transport>" of the iPhone to use, or nothing.
find_device() {
  local json="$STATE/devices.json"
  xcrun devicectl list devices --json-output "$json" >/dev/null 2>&1 || return 0
  /usr/bin/python3 - "$json" "$DEVICE" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
want = sys.argv[2].strip().lower()
best = None
for d in data.get('result', {}).get('devices', []):
    hw = d.get('hardwareProperties', {})
    props = d.get('deviceProperties', {})
    conn = d.get('connectionProperties', {})
    if hw.get('platform') != 'iOS' or hw.get('reality') == 'virtual':
        continue
    ids = {str(d.get('identifier', '')).lower(), str(hw.get('udid', '')).lower(), str(props.get('name', '')).lower()}
    if want and want not in ids:
        continue
    usable = conn.get('pairingState') == 'paired' and conn.get('tunnelState') != 'unavailable'
    if not usable:
        continue
    row = (d['identifier'], props.get('name', '?'), conn.get('transportType', '?'))
    if best is None or conn.get('tunnelState') == 'connected':
        best = row
if best:
    print('\t'.join(best))
PY
}

# ── Steps ────────────────────────────────────────────────────────────────────

update_code() {
  [ "$AUTO_UPDATE" = "1" ] || return 0
  [ -d "$REPO/.git" ] || return 0
  local before after
  before="$(git -C "$REPO" rev-parse HEAD 2>/dev/null)"
  if git -C "$REPO" pull --ff-only --quiet >>"$LOG" 2>&1; then
    after="$(git -C "$REPO" rev-parse HEAD)"
    [ "$before" != "$after" ] && log "Код обновлён: ${before:0:7} → ${after:0:7}"
  else
    log "Не удалось обновить код из GitHub — собираю текущую версию"
  fi
}

build_web() {
  cd "$REPO" || fail "нет папки проекта $REPO"
  local lockhash
  lockhash="$(/sbin/md5 -q package-lock.json)"
  if [ ! -d node_modules ] || [ "$(cat "$STATE/lockhash" 2>/dev/null)" != "$lockhash" ]; then
    log "Устанавливаю зависимости (npm ci)…"
    npm ci --no-audit --no-fund >>"$LOG" 2>&1 || fail "npm ci завершился с ошибкой"
    echo "$lockhash" >"$STATE/lockhash"
  fi
  log "Собираю веб-часть…"
  npx vite build >>"$LOG" 2>&1 || fail "сборка веб-части не удалась"
  npx cap sync ios >>"$LOG" 2>&1 || fail "cap sync ios не удался"
}

build_ios() {
  [ -n "$TEAM_ID" ] || fail "не задан TEAM_ID в $CONFIG (запустите setup-automation.sh)"
  log "Собираю и подписываю iOS-приложение (команда $TEAM_ID)…"
  xcodebuild \
    -project "$REPO/ios/App/App.xcodeproj" \
    -scheme App \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -derivedDataPath "$DERIVED" \
    -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    CODE_SIGN_STYLE=Automatic \
    PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
    build >>"$LOG" 2>&1 || fail "xcodebuild не смог собрать или подписать приложение (подробности в $LOG)"
  [ -d "$APP_PATH" ] || fail "не найден собранный App.app"
}

profile_expiry() {
  # Prints the expiry of the profile embedded in the built app as epoch seconds.
  local app="${1:-$APP_PATH}"
  [ -f "$app/embedded.mobileprovision" ] || return 0
  security cms -D -i "$app/embedded.mobileprovision" 2>/dev/null >"$STATE/profile.plist" || return 0
  local iso
  iso="$(/usr/bin/plutil -extract ExpirationDate raw -o - "$STATE/profile.plist" 2>/dev/null)" || return 0
  /bin/date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$iso" '+%s' 2>/dev/null
}

app_installed() {
  xcrun devicectl device info apps --device "$1" --bundle-id "$BUNDLE_ID" --json-output "$STATE/apps.json" >/dev/null 2>&1 || return 1
  /usr/bin/python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get('result',{}).get('apps') else 1)" "$STATE/apps.json"
}

backup_from_device() {
  local dev="$1"
  if ! app_installed "$dev"; then
    log "Приложение ещё не установлено на iPhone — копировать нечего"
    return 0
  fi
  local dest
  dest="$BACKUP_DIR/$(date '+%Y-%m-%d_%H-%M')"
  mkdir -p "$dest"
  if xcrun devicectl device copy from --device "$dev" --domain-type appDataContainer --domain-identifier "$BUNDLE_ID" \
    --source Documents/Backups --destination "$dest" >>"$LOG" 2>&1; then
    log "Копии с iPhone сохранены: $dest"
  else
    rmdir "$dest" 2>/dev/null
    log "Не удалось скопировать резервные копии с iPhone (продолжаю: данные приложения при переустановке не теряются)"
  fi
  # Keep the 20 most recent snapshots.
  local all total
  all="$(ls -1d "$BACKUP_DIR"/20* 2>/dev/null | sort)"
  total="$(printf '%s\n' "$all" | grep -c . || true)"
  if [ "$total" -gt 20 ]; then
    printf '%s\n' "$all" | head -n $((total - 20)) | while read -r old; do rm -rf "$old"; done
  fi
}

install_app() {
  local dev="$1"
  log "Устанавливаю на iPhone поверх текущей версии (данные сохраняются)…"
  xcrun devicectl device install app --device "$dev" "$APP_PATH" >>"$LOG" 2>&1 || fail "установка на iPhone не удалась — телефон разблокирован и в той же сети?"
  local exp
  exp="$(profile_expiry)"
  [ -n "$exp" ] && echo "$exp" >"$STATE/expires_at"
  date '+%s' >"$STATE/last_install"
  local human
  human="$([ -n "$exp" ] && /bin/date -r "$exp" '+%d.%m %H:%M' || echo '?')"
  log "Готово. Подпись действует до $human"
  notify "Приложение продлено" "Mnemo будет открываться до $human"
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_install() {
  lock
  trim_log
  log "=== Установка ($1) ==="
  local row dev name transport
  row="$(find_device)"
  [ -n "$row" ] || fail "iPhone не найден. Подключите его кабелем или к той же Wi-Fi сети, что и Mac, и разблокируйте"
  IFS=$'\t' read -r dev name transport <<<"$row"
  log "iPhone: $name ($transport)"
  update_code
  build_web
  build_ios
  backup_from_device "$dev"
  install_app "$dev"
}

cmd_auto() {
  local now exp left
  now="$(date '+%s')"
  exp="$(cat "$STATE/expires_at" 2>/dev/null || echo 0)"
  left=$((exp - now))
  if [ "$left" -gt $((RENEW_BEFORE_HOURS * 3600)) ]; then
    trim_log
    log "Подпись ещё действует $((left / 3600)) ч — продлевать рано"
    exit 0
  fi
  if [ -z "$(find_device)" ]; then
    log "Пора продлевать, но iPhone недоступен — повторю позже"
    if [ "$exp" -gt 0 ] && [ "$left" -lt $((24 * 3600)) ]; then
      local when
      when="$( [ "$left" -gt 0 ] && echo "через $((left / 3600)) ч" || echo 'уже' )"
      notify "Нужен iPhone" "Mnemo перестанет открываться $when. Подключите iPhone к Mac или к той же Wi-Fi сети и разблокируйте."
    fi
    exit 0
  fi
  cmd_install auto
}

cmd_backup() {
  local row dev name transport
  row="$(find_device)"
  [ -n "$row" ] || fail "iPhone не найден"
  IFS=$'\t' read -r dev name transport <<<"$row"
  backup_from_device "$dev"
}

cmd_status() {
  local exp row
  exp="$(cat "$STATE/expires_at" 2>/dev/null || echo 0)"
  row="$(find_device)"
  echo "Проект:      $REPO"
  echo "Bundle ID:   $BUNDLE_ID"
  echo "Команда:     ${TEAM_ID:-не задана}"
  echo "iPhone:      ${row:-не найден}"
  if [ "$exp" -gt 0 ]; then
    echo "Подпись до:  $(/bin/date -r "$exp" '+%d.%m.%Y %H:%M') (осталось $(( (exp - $(date +%s)) / 3600 )) ч)"
  else
    echo "Подпись до:  неизвестно (ещё не устанавливали)"
  fi
  echo "Копии:       $BACKUP_DIR"
  echo "Журнал:      $LOG"
  [ -f "$LOG" ] && { echo; tail -n 8 "$LOG"; }
}

case "${1:-status}" in
  install) cmd_install manual ;;
  auto) cmd_auto ;;
  backup) cmd_backup ;;
  status) cmd_status ;;
  *)
    echo "Использование: $0 {install|auto|backup|status}" >&2
    exit 2
    ;;
esac
