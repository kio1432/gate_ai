#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/extension/manifest.json').version")"
TAG="v${VERSION}"
ZIP="$ROOT/dist/blockai-extension-v${VERSION}.zip"

cd "$ROOT"

if ! command -v gh >/dev/null 2>&1; then
  echo "Установите GitHub CLI: brew install gh"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Войдите в GitHub: gh auth login"
  exit 1
fi

bash "$ROOT/scripts/pack-extension.sh"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Тег $TAG уже существует локально"
else
  git tag -a "$TAG" -m "BlockAI $TAG"
  git push origin "$TAG"
fi

gh release upload "$TAG" "$ZIP" --clobber 2>/dev/null || \
gh release create "$TAG" "$ZIP" \
  --title "BlockAI $TAG" \
  --notes "$(cat <<EOF
## Установка

Скачайте **blockai-extension-v${VERSION}.zip** из Assets (не «Source code»).

1. Распакуйте архив
2. \`chrome://extensions\` → **Режим разработчика** → **Загрузить распакованное**
3. Выберите папку с \`manifest.json\`
EOF
)"

echo ""
echo "✔ Релиз: https://github.com/kio1432/gate_ai/releases/tag/$TAG"
