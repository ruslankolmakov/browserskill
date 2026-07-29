#!/usr/bin/env bash
# Регистрирует native messaging хосты ffmcp для Firefox и Chrome на macOS.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${FFMCP_DIR:-$HOME/.ffmcp}"
NODE_BIN="$(command -v node)"
FF_EXT_ID="ffmcp@local"
# ID расширения Chrome детерминирован: он выведен из поля "key" в
# extension-chrome/manifest.json, поэтому одинаков на любой машине.
CHROME_EXT_ID="mifolcjccjkcdfdoebmkgklimogoemng"

if [[ -z "$NODE_BIN" ]]; then
  echo "❌ node не найден в PATH" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
chmod +x "$ROOT/bin/"*.js

# Браузер, запущенный из Finder, наследует урезанный PATH, поэтому путь к node
# зашиваем абсолютным в скрипт-обёртку. Отдельный лаунчер на браузер: по флагу
# --browser хост понимает, чей сокет поднимать.
make_launcher() {
  local browser="$1" file="$STATE_DIR/host-$1.sh"
  cat > "$file" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$ROOT/bin/ffmcp-host.js" --browser=$browser "\$@"
EOF
  chmod +x "$file"
  echo "$file"
}

FF_LAUNCHER="$(make_launcher firefox)"
CHROME_LAUNCHER="$(make_launcher chrome)"

# --- Firefox: allowed_extensions с id дополнения ---
FF_DIRS=(
  "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
)

for dir in "${FF_DIRS[@]}"; do
  mkdir -p "$dir"
  cat > "$dir/ffmcp.json" <<EOF
{
  "name": "ffmcp",
  "description": "ffmcp bridge — доступ MCP-агентов к Firefox",
  "path": "$FF_LAUNCHER",
  "type": "stdio",
  "allowed_extensions": ["$FF_EXT_ID"]
}
EOF
  echo "✅ Firefox: $dir/ffmcp.json"
done

# --- Chrome и родня: allowed_origins с origin расширения ---
CHROME_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome"
  "$HOME/Library/Application Support/Google/Chrome Beta"
  "$HOME/Library/Application Support/Google/Chrome Canary"
  "$HOME/Library/Application Support/Chromium"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser"
  "$HOME/Library/Application Support/Microsoft Edge"
  "$HOME/Library/Application Support/Vivaldi"
  "$HOME/Library/Application Support/Arc/User Data"
)

chrome_found=0
for base in "${CHROME_DIRS[@]}"; do
  # Каталог профиля есть только у реально установленного браузера — не плодим
  # манифесты для тех, кого нет.
  [[ -d "$base" ]] || continue
  dir="$base/NativeMessagingHosts"
  mkdir -p "$dir"
  cat > "$dir/ffmcp.json" <<EOF
{
  "name": "ffmcp",
  "description": "ffmcp bridge — доступ MCP-агентов к Chrome",
  "path": "$CHROME_LAUNCHER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$CHROME_EXT_ID/"]
}
EOF
  echo "✅ Chrome:  $dir/ffmcp.json"
  chrome_found=1
done

if [[ "$chrome_found" == "0" ]]; then
  echo "ℹ️  браузеров на базе Chromium не найдено — манифест для Chrome не ставился"
fi

echo "✅ лаунчеры: $FF_LAUNCHER, $CHROME_LAUNCHER (node: $NODE_BIN)"
echo
echo "Дальше — расширения:"
echo
echo "  Firefox:"
echo "    1. about:debugging#/runtime/this-firefox"
echo "    2. «Загрузить временное дополнение…» → $ROOT/extension/manifest.json"
echo
echo "  Chrome:"
echo "    1. chrome://extensions → включи «Режим разработчика»"
echo "    2. «Загрузить распакованное расширение» → $ROOT/extension-chrome"
echo "    3. ID должен получиться $CHROME_EXT_ID"
echo "    4. По желанию: в карточке расширения включи «Разрешить пользовательские скрипты»"
echo "       — без этого browser_eval не работает на сайтах со строгим CSP"
echo
echo "  Проверка: $ROOT/bin/ffmcp.js doctor"
echo
echo "Подключение к Claude Code (один сервер на оба браузера):"
echo "  claude mcp add browser -- $NODE_BIN $ROOT/bin/ffmcp-mcp.js"
