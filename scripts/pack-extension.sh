#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$ROOT/extension"
OUT_CRX="$ROOT/blockai.crx"
VERSION="$(node -p "require('$ROOT/extension/manifest.json').version" 2>/dev/null || echo "dev")"
OUT_ZIP="$ROOT/dist/blockai-extension-v${VERSION}.zip"
KEY_FILE="$ROOT/extension.pem"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

cd "$ROOT"
npm run build --silent

# ZIP — только файлы расширения (manifest.json в корне архива)
mkdir -p "$(dirname "$OUT_ZIP")"
rm -f "$OUT_ZIP"
rm -rf "$EXT_DIR/_metadata"
(cd "$EXT_DIR" && zip -r "$OUT_ZIP" . -x "*.DS_Store" -x "_metadata/*")

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
echo "  1. Распакуйте архив"
echo "  2. chrome://extensions → Режим разработчика"
echo "  3. «Загрузить распакованное» → папка с manifest.json"
