#!/usr/bin/env bash
# Установка browserskill одной командой (macOS):
#
#   curl -fsSL https://raw.githubusercontent.com/ruslankolmakov/browserskill/main/get.sh | bash
#
# Клонирует (или обновляет) репозиторий, регистрирует native-хосты и скилл,
# открывает страницы расширений в найденных браузерах. Повторный запуск = обновление.
# Куда класть код: BROWSERSKILL_SRC (по умолчанию ~/.browserskill/app).
set -euo pipefail

REPO="https://github.com/ruslankolmakov/browserskill.git"
SRC="${BROWSERSKILL_SRC:-$HOME/.browserskill/app}"
CHROME_EXT_ID="mifolcjccjkcdfdoebmkgklimogoemng"

say() { printf '%s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "пока только macOS"
command -v git >/dev/null || die "нужен git: xcode-select --install"
if ! command -v node >/dev/null; then
  if command -v brew >/dev/null; then
    say "▸ node не найден — ставлю через Homebrew"
    brew install node
  else
    die "нужен Node.js ≥ 18: brew install node  (или https://nodejs.org)"
  fi
fi

if [[ -d "$SRC/.git" ]]; then
  say "▸ обновляю $SRC"
  git -C "$SRC" pull -q --ff-only
else
  say "▸ клонирую в $SRC"
  mkdir -p "$(dirname "$SRC")"
  git clone -q "$REPO" "$SRC"
fi

say "▸ регистрирую хосты и скилл"
"$SRC/install.sh" | grep -E '^(✅|ℹ️)' || true

# Какие браузеры есть на машине
have_app() { [[ -d "/Applications/$1.app" || -d "$HOME/Applications/$1.app" ]]; }
CHROMES=()
for app in "Google Chrome" "Chromium" "Brave Browser" "Microsoft Edge" "Vivaldi" "Arc"; do
  have_app "$app" && CHROMES+=("$app")
done
HAVE_FF=0; have_app "Firefox" && HAVE_FF=1

say
say "Осталось загрузить расширение (одного браузера достаточно):"
say
if ((${#CHROMES[@]})); then
  say "  ${CHROMES[0]}: страница расширений уже открыта."
  say "    1. включи «Режим разработчика» (справа сверху)"
  say "    2. «Загрузить распакованное расширение» → в диалоге нажми ⌘⇧G и вставь путь (он в буфере):"
  say "       $SRC/extension-chrome"
  say "    3. ID должен получиться $CHROME_EXT_ID"
  say "    4. по желанию включи «Разрешить пользовательские скрипты» — для eval на сайтах со строгим CSP"
  printf '%s' "$SRC/extension-chrome" | pbcopy
  open -a "${CHROMES[0]}" "chrome://extensions" 2>/dev/null || true
fi
if ((HAVE_FF)); then
  say
  say "  Firefox: страница about:debugging уже открыта."
  say "    «Загрузить временное дополнение…» → $SRC/extension/manifest.json"
  say "    (временное дополнение живёт до перезапуска Firefox)"
  ((${#CHROMES[@]})) || printf '%s' "$SRC/extension" | pbcopy
  open -a Firefox "about:debugging#/runtime/this-firefox" 2>/dev/null || true
fi
if ((${#CHROMES[@]} == 0 && HAVE_FF == 0)); then
  say "  Браузеры не найдены в /Applications — поставь Chrome или Firefox и запусти команду снова."
fi
say
say "Проверка:  node $SRC/bin/browserskill.js doctor"
say "Обновить:  та же команда curl … | bash"
