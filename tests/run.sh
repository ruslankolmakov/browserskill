#!/usr/bin/env bash
# Прогон всех тестов. Живой Firefox не требуется — расширение и браузер
# заменяются заглушками, проверяется логика моста и защита от зацикливания.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail=0

echo "▸ синтаксис"
for f in extension/*.js bin/*.js; do
  if node --check "$f" >/dev/null 2>&1; then echo "  ✅ $f"; else echo "  ❌ $f"; fail=1; fi
done

for t in tests/*.test.js; do
  echo "▸ $(basename "$t")"
  if timeout 60 node "$t" 2>&1 | sed 's/^/  /'; then :; else fail=1; fi
  # шаг проваливается, если внутри теста был exit != 0
  if [ "${PIPESTATUS[0]}" != "0" ]; then fail=1; fi
done

echo
if [ "$fail" = "0" ]; then echo "✅ все тесты прошли"; else echo "❌ есть падения"; fi
exit $fail
