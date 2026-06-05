# Архитектура BlockAI

## Обзор

BlockAI — Chrome Extension (Manifest V3) с тремя слоями защиты:

```
Пользователь → claude.ai / anthropic.com
                    │
                    ▼
         ┌──────────────────────┐
         │  DNR (rules.json)    │  ← статические правила, enabled по умолчанию
         │  main_frame → шлюз   │
         │  остальное → BLOCK   │
         └──────────┬───────────┘
                    ▼
         ┌──────────────────────┐
         │  blocked.html        │  ← GeoIP-проверка
         │  (шлюз)              │
         └──────────┬───────────┘
                    │ allowed
                    ▼
         ┌──────────────────────┐
         │  Claude (с VPN IP)   │
         │  + content script    │  ← периодический recheck
         └──────────────────────┘
```

## Компоненты

### `extension/rules.json` + `src/extension/rules.ts`

Статический ruleset `block_claude` в manifest (`enabled: true`):

| Правило | Тип запроса | Действие |
|---------|-------------|----------|
| claude.ai, claude.com, anthropic.com | `main_frame` | Redirect → `blocked.html` |
| те же домены | XHR, script, WebSocket, … | `block` |

Правила активны **до запуска** service worker — нет гонки при старте браузера.

После успешной проверки service worker вызывает `disableBlocking()` (отключает ruleset). При deny или старте — `enableBlocking()`.

### `src/extension/background.ts`

Service worker:

- `init()` — всегда включает блокировку, сбрасывает сессию
- `runCheck()` — GeoIP через `region-gate`
- `applyVerdict()` — storage + toggle ruleset + редирект вкладок

Сообщения: `RECHECK`, `GET_STATUS`, `GET_SETTINGS`, `SAVE_SETTINGS`, `WAKE`.

### `src/extension/blocked.ts`

Страница-шлюз:

1. При загрузке сразу `RECHECK`
2. `allowed` → `location.replace('https://claude.ai')`
3. Иначе — UI с кнопкой «Проверить снова»

### `src/extension/content.ts`

На вкладках Claude (`document_start`):

- Скрывает страницу до подтверждения (`visibility:hidden`)
- Слушает `gate:lastResult` в storage
- Интервал recheck (из настроек popup)
- `visibilitychange` → recheck при возврате на вкладку

### `src/lib/region-gate/`

Независимое ядро проверки региона:

| Файл | Назначение |
|------|------------|
| `checker.ts` | Агрегация ответов провайдеров, вердикт |
| `providers.ts` | GeoIP API (country.is, geojs.io, ipinfo.io, ifconfig.co) |
| `obfuscate.ts` | Обфусцированные эндпоинты и список блокируемых стран |
| `types.ts` | `RegionGateResult`, `verdict: allowed \| blocked \| unknown` |

**Fail-closed:** `unknown` → блок. RU определяется через обфусцированные коды символов.

Быстрая проверка (`FAST_PROVIDERS`): country.is + geojs.io, timeout 2 с, `minSuccessfulProviders: 1`.

## Поток: первый вход

1. Пользователь открывает `claude.ai`
2. DNR редиректит на `blocked.html` (Claude **не получает** HTTP-запрос)
3. Шлюз вызывает GeoIP (запросы только к GeoIP-провайдерам)
4. Вердикт `allowed` → ruleset отключается → редирект на Claude
5. Claude видит IP **VPN**, не реальный

## Поток: VPN отключился на вкладке

1. Content script по таймеру → `RECHECK`
2. Вердикт `blocked` / `unknown`
3. `enableBlocking()` + редирект вкладок на шлюз
4. DNR снова блокирует все запросы к Claude/Anthropic

## Защищаемые домены

- `claude.ai`, `*.claude.ai`
- `claude.com`, `*.claude.com`
- `anthropic.com`, `*.anthropic.com`

## Хранилище (`chrome.storage.local`)

| Ключ | Содержимое |
|------|------------|
| `gate:lastResult` | Последний `RegionGateResult` |
| `gate:sessionActive` | Флаг активной сессии |
| `gate:settings` | `{ recheckIntervalSec }` |

Старый вердикт `allowed` **не доверяется** при старте — блокировка включается заново.

## Сборка

Vite собирает entry points из `src/extension/` в `extension/*.js`. Статические файлы (`manifest.json`, `rules.json`, HTML, иконки) лежат в `extension/` и не перезаписываются (`emptyOutDir: false`).
