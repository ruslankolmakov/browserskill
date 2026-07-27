#!/usr/bin/env bash
# Регистрирует native messaging хост ffmcp для Firefox на macOS.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${FFMCP_DIR:-$HOME/.ffmcp}"
LAUNCHER="$STATE_DIR/host-launcher.sh"
NODE_BIN="$(command -v node)"
EXT_ID="ffmcp@local"

if [[ -z "$NODE_BIN" ]]; then
  echo "❌ node не найден в PATH" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

# Firefox, запущенный из Finder, наследует урезанный PATH, поэтому путь к node
# зашиваем абсолютным в скрипт-обёртку.
cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$ROOT/bin/ffmcp-host.js" "\$@"
EOF
chmod +x "$LAUNCHER"
chmod +x "$ROOT/bin/"*.js

# Манифесты кладём во все каталоги, где их ищут сборки Firefox.
MANIFEST_DIRS=(
  "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
)

for dir in "${MANIFEST_DIRS[@]}"; do
  mkdir -p "$dir"
  cat > "$dir/ffmcp.json" <<EOF
{
  "name": "ffmcp",
  "description": "ffmcp bridge — доступ MCP-агентов к Firefox",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_extensions": ["$EXT_ID"]
}
EOF
  echo "✅ манифест: $dir/ffmcp.json"
done

echo "✅ лаунчер:  $LAUNCHER (node: $NODE_BIN)"
echo
echo "Дальше:"
echo "  1. Открой в Firefox about:debugging#/runtime/this-firefox"
echo "  2. «Загрузить временное дополнение…» → выбери $ROOT/extension/manifest.json"
echo "  3. Проверь: $ROOT/bin/ffmcp.js doctor"
echo
echo "Подключение к Claude Code:"
echo "  claude mcp add firefox -- $NODE_BIN $ROOT/bin/ffmcp-mcp.js"
