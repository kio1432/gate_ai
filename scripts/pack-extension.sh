#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$ROOT/extension"
OUT_CRX="$ROOT/blockai.crx"
OUT_ZIP="$ROOT/blockai.zip"
KEY_FILE="$ROOT/extension.pem"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

cd "$ROOT"
npm run build --silent

# ZIP — надёжный способ установки (Chrome блокирует локальные .crx)
rm -f "$OUT_ZIP"
(cd "$EXT_DIR" && zip -r "$OUT_ZIP" . -x "*.DS_Store")

if [[ -x "$CHROME" ]]; then
  ARGS=(--pack-extension="$EXT_DIR")
  [[ -f "$KEY_FILE" ]] && ARGS+=(--pack-extension-key="$KEY_FILE")
  "$CHROME" "${ARGS[@]}" 2>/dev/null || true
  [[ -f "$ROOT/extension.crx" ]] && mv -f "$ROOT/extension.crx" "$OUT_CRX"
  [[ -f "$ROOT/extension.pem" && ! -f "$KEY_FILE" ]] && mv -f "$ROOT/extension.pem" "$KEY_FILE"
fi

echo ""
echo "✔ ZIP (рекомендуется): $OUT_ZIP"
[[ -f "$OUT_CRX" ]] && echo "✔ CRX: $OUT_CRX"
echo ""
echo "Установка:"
echo "  1. Распакуйте blockai.zip"
echo "  2. chrome://extensions → Режим разработчика"
echo "  3. «Загрузить распакованное» → папка extension"
